package com.example.posture.service;

import com.example.posture.constant.InputType;
import com.example.posture.constant.QualityLevel;
import com.example.posture.constant.TaskStatus;
import com.example.posture.dto.InferenceHistoryItem;
import com.example.posture.dto.InferenceResultItem;
import com.example.posture.dto.InferenceTaskDetail;
import com.example.posture.dto.JsonInferenceRequest;
import com.example.posture.dto.LatestAdviceDto;
import com.example.posture.dto.PageResult;
import com.example.posture.dto.PredictData;
import com.example.posture.dto.PredictApiResponse;
import com.example.posture.dto.PredictResult;
import com.example.posture.dto.ScoreItem;
import com.example.posture.dto.ScoreRequest;
import com.example.posture.entity.InferenceResult;
import com.example.posture.entity.InferenceTask;
import com.example.posture.entity.RawDataFile;
import com.example.posture.repository.InferenceResultRepository;
import com.example.posture.repository.InferenceTaskRepository;
import com.example.posture.repository.RawDataFileRepository;
import tools.jackson.core.JacksonException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

@Service
public class InferenceService {

    private final ModelClientService modelClientService;
    private final AiCoachService aiCoachService;
    private final InferenceTaskRepository inferenceTaskRepository;
    private final InferenceResultRepository inferenceResultRepository;
    private final RawDataFileRepository rawDataFileRepository;
    private final ObjectMapper objectMapper;
    private final Path uploadDir;
    private final Path rawDataDir;

    public InferenceService(
        ModelClientService modelClientService,
        AiCoachService aiCoachService,
        InferenceTaskRepository inferenceTaskRepository,
        InferenceResultRepository inferenceResultRepository,
        RawDataFileRepository rawDataFileRepository,
        ObjectMapper objectMapper,
        @Value("${app.upload.dir}") String uploadDir,
        @Value("${app.raw-data.dir}") String rawDataDir
    ) {
        this.modelClientService = modelClientService;
        this.aiCoachService = aiCoachService;
        this.inferenceTaskRepository = inferenceTaskRepository;
        this.inferenceResultRepository = inferenceResultRepository;
        this.rawDataFileRepository = rawDataFileRepository;
        this.objectMapper = objectMapper;
        this.uploadDir = Path.of(uploadDir).toAbsolutePath().normalize();
        this.rawDataDir = Path.of(rawDataDir).toAbsolutePath().normalize();
    }

    public PredictApiResponse uploadAndPredict(MultipartFile file) throws IOException {
        if (file.isEmpty()) {
            throw new IllegalArgumentException("Uploaded file is empty");
        }

        Files.createDirectories(uploadDir);
        Path savedFilePath = saveFile(file);
        return modelClientService.predictByPath(savedFilePath.toString());
    }

    public PredictApiResponse predictJson(Map<String, Object> request) {
        Object frames = request == null ? null : request.get("frames");
        if (!(frames instanceof List<?>) || ((List<?>) frames).isEmpty()) {
            throw new IllegalArgumentException("frames must not be empty");
        }

        String taskNo = "INF-" + UUID.randomUUID().toString().replace("-", "");
        InferenceTask task = createJsonTask(taskNo, request);
        try {
            Path rawJsonPath = saveRawJson(taskNo, request);
            task.setRawDataPath(rawJsonPath.toString());
            task.setStatus(TaskStatus.PROCESSING);
            task = inferenceTaskRepository.save(task);
            saveRawDataFile(task, rawJsonPath, ((List<?>) frames).size());

            PredictApiResponse response = modelClientService.predictByJson(request);
            if (response != null) {
                response.setTaskNo(taskNo);
                enrichAiCoachAdvice(response);
            }
            try {
                saveInferenceResults(task, response);
            } catch (RuntimeException e) {
                task.setStatus(TaskStatus.FAILED);
                task.setErrorMessage("Failed to persist inference results: " + e.getMessage());
                inferenceTaskRepository.save(task);
                PredictApiResponse failedResponse = new PredictApiResponse();
                failedResponse.setSuccess(false);
                failedResponse.setTaskNo(taskNo);
                failedResponse.setFilename("Result persistence failed");
                return failedResponse;
            }
            task.setStatus(TaskStatus.SUCCESS);
            task.setErrorMessage(null);
            inferenceTaskRepository.save(task);
            return response;
        } catch (RuntimeException | IOException exc) {
            task.setStatus(TaskStatus.FAILED);
            task.setErrorMessage(exc.getMessage());
            inferenceTaskRepository.save(task);
            PredictApiResponse failedResponse = new PredictApiResponse();
            failedResponse.setSuccess(false);
            failedResponse.setTaskNo(taskNo);
            failedResponse.setFilename(exc.getMessage());
            return failedResponse;
        }
    }

    public PredictApiResponse predictJson(String requestBody) {
        if (requestBody == null || requestBody.isBlank()) {
            throw new IllegalArgumentException("request body must not be empty");
        }
        try {
            Map<String, Object> request = objectMapper.readValue(
                requestBody,
                new TypeReference<Map<String, Object>>() {
                }
            );
            return predictJson(request);
        } catch (JacksonException exc) {
            throw new IllegalArgumentException("request body must be a JSON object with frames array", exc);
        }
    }

    public PredictApiResponse predictJson(JsonInferenceRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request body must not be empty");
        }
        Map<String, Object> payload = objectMapper.convertValue(
            request,
            new TypeReference<Map<String, Object>>() {
            }
        );
        return predictJson(payload);
    }

    public PageResult<InferenceHistoryItem> listHistory(int page, int size) {
        Page<InferenceTask> taskPage = inferenceTaskRepository.findAllByOrderByCreatedAtDesc(
            PageRequest.of(page, size));
        List<InferenceHistoryItem> list = taskPage.getContent()
            .stream()
            .map(this::toHistoryItem)
            .toList();
        return new PageResult<>(list, page, size,
            taskPage.getTotalElements(), taskPage.getTotalPages());
    }

    public LatestAdviceDto getLatestAdvice() {
        Page<InferenceTask> page = inferenceTaskRepository.findAllByOrderByCreatedAtDesc(
            PageRequest.of(0, 1));
        if (!page.hasContent()) {
            return null;
        }
        InferenceTask task = page.getContent().get(0);
        List<InferenceResult> results = inferenceResultRepository.findByTaskIdOrderBySampleIndexAsc(task.getId());
        List<LatestAdviceDto.AdviceItem> items = results.stream()
            .map(r -> new LatestAdviceDto.AdviceItem(
                r.getSampleIndex(), r.getActionLabelName(), r.getConfidence(),
                r.getQualityScore(), r.getQualityLevel(),
                r.getCoachingAdvice(), r.getAiCoachAdvice()))
            .toList();
        return new LatestAdviceDto(task.getTaskNo(), task.getSessionId(),
            task.getStatus().name(), task.getCreatedAt(), items);
    }

    public InferenceTaskDetail getTaskDetail(String taskNo) {
        InferenceTask task = findTaskByTaskNo(taskNo);
        Optional<RawDataFile> rawDataFile = rawDataFileRepository.findFirstByTaskIdOrderByCreatedAtDesc(task.getId());
        return new InferenceTaskDetail(
            task.getTaskNo(),
            task.getSessionId(),
            task.getInputType().name(),
            task.getStatus().name(),
            task.getRawDataPath(),
            rawDataFile.map(RawDataFile::getFrameCount).orElse(null),
            rawDataFile.map(RawDataFile::getSizeBytes).orElse(null),
            task.getErrorMessage(),
            task.getCreatedAt(),
            task.getUpdatedAt(),
            getTaskResults(taskNo)
        );
    }

    public List<InferenceResultItem> getTaskResults(String taskNo) {
        InferenceTask task = findTaskByTaskNo(taskNo);
        return inferenceResultRepository.findByTaskIdOrderBySampleIndexAsc(task.getId())
            .stream()
            .map(this::toResultItem)
            .toList();
    }

    public List<InferenceResultItem> saveScore(String taskNo, ScoreRequest request) {
        InferenceTask task = findTaskByTaskNo(taskNo);
        List<ScoreItem> items = request.getResults();
        if (items == null || items.isEmpty()) {
            throw new IllegalArgumentException("results must not be empty");
        }

        for (ScoreItem item : items) {
            if (item.getQualityLevel() != null && !QualityLevel.isValid(item.getQualityLevel())) {
                throw new IllegalArgumentException(
                    "qualityLevel 非法，合法值为：优秀/良好/一般/不合格，当前值: " + item.getQualityLevel());
            }
            InferenceResult result = new InferenceResult();
            result.setTaskId(task.getId());
            result.setSampleIndex(item.getSampleIndex() != null ? item.getSampleIndex() : 0);
            result.setActionLabelName(item.getActionLabelName());
            result.setQualityScore(item.getQualityScore());
            result.setQualityLevel(item.getQualityLevel() != null
                ? item.getQualityLevel()
                : deriveQualityLevel(item.getQualityScore()));
            result.setCoachingAdvice(item.getCoachingAdvice());
            result.setRawResultJson(toJson(item));
            inferenceResultRepository.save(result);
        }

        task.setStatus(TaskStatus.SUCCESS);
        task.setErrorMessage(null);
        inferenceTaskRepository.save(task);

        return getTaskResults(taskNo);
    }

    private String deriveQualityLevel(Double score) {
        if (score == null) return QualityLevel.FAIL.getLabel();
        return QualityLevel.fromScore(score);
    }

    private Path saveFile(MultipartFile file) throws IOException {
        String originalFilename = Objects.requireNonNullElse(file.getOriginalFilename(), "upload.csv");
        String safeFilename = Path.of(originalFilename).getFileName().toString();
        String storedFilename = UUID.randomUUID() + "_" + safeFilename;
        Path targetPath = uploadDir.resolve(storedFilename).normalize();

        try (InputStream inputStream = file.getInputStream()) {
            Files.copy(inputStream, targetPath, StandardCopyOption.REPLACE_EXISTING);
        }

        return targetPath;
    }

    private InferenceTask createJsonTask(String taskNo, Map<String, Object> request) {
        InferenceTask task = new InferenceTask();
        task.setTaskNo(taskNo);
        String sessionId = extractString(request.get("sessionId"));
        String mac = extractString(request.get("mac"));
        task.setSessionId(sessionId != null ? sessionId : mac);
        task.setInputType(InputType.JSON);
        task.setStatus(TaskStatus.PENDING);
        return inferenceTaskRepository.save(task);
    }

    private Path saveRawJson(String taskNo, Map<String, Object> request) throws IOException {
        String day = LocalDate.now().format(DateTimeFormatter.BASIC_ISO_DATE);
        Path dayDir = rawDataDir.resolve(day).normalize();
        Files.createDirectories(dayDir);
        Path targetPath = dayDir.resolve(taskNo + ".json").normalize();
        String json = objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(request);
        Files.writeString(targetPath, json, StandardCharsets.UTF_8);
        return targetPath;
    }

    private void saveRawDataFile(InferenceTask task, Path rawJsonPath, int frameCount) throws IOException {
        RawDataFile rawDataFile = new RawDataFile();
        rawDataFile.setTaskId(task.getId());
        rawDataFile.setFilePath(rawJsonPath.toString());
        rawDataFile.setFileType("JSON");
        rawDataFile.setFrameCount(frameCount);
        rawDataFile.setSizeBytes(Files.size(rawJsonPath));
        rawDataFileRepository.save(rawDataFile);
    }

    private void saveInferenceResults(InferenceTask task, PredictApiResponse response) {
        PredictData data = response == null ? null : response.getData();
        List<PredictResult> results = data == null || data.getResults() == null ? List.of() : data.getResults();
        for (PredictResult result : results) {
            InferenceResult entity = new InferenceResult();
            entity.setTaskId(task.getId());
            entity.setSampleIndex(result.getSampleIndex());
            if (result.getPrediction() != null) {
                entity.setActionLabelId(result.getPrediction().getLabelId());
                entity.setActionLabelName(result.getPrediction().getLabelName());
                entity.setConfidence(result.getPrediction().getConfidence());
            }
            entity.setQualityScore(result.getQualityScore());
            entity.setQualityLevel(result.getQualityLevel());
            entity.setCoachingAdvice(result.getCoachingAdvice());
            entity.setAiCoachAdvice(result.getAiCoachAdvice());
            entity.setRawResultJson(toJson(result));
            inferenceResultRepository.save(entity);
        }
    }

    private void enrichAiCoachAdvice(PredictApiResponse response) {
        PredictData data = response.getData();
        List<PredictResult> results = data == null || data.getResults() == null ? List.of() : data.getResults();
        for (PredictResult result : results) {
            result.setAiCoachAdvice(aiCoachService.generateAdvice(result));
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JacksonException exc) {
            return "{}";
        }
    }

    private String extractString(Object value) {
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }

    private InferenceTask findTaskByTaskNo(String taskNo) {
        return inferenceTaskRepository.findByTaskNo(taskNo)
            .orElseThrow(() -> new IllegalArgumentException("Inference task does not exist: " + taskNo));
    }

    private InferenceHistoryItem toHistoryItem(InferenceTask task) {
        List<InferenceResult> results = inferenceResultRepository.findByTaskIdOrderBySampleIndexAsc(task.getId());
        InferenceHistoryItem item = new InferenceHistoryItem();
        item.setTaskNo(task.getTaskNo());
        item.setSessionId(task.getSessionId());
        item.setInputType(task.getInputType().name());
        item.setStatus(task.getStatus().name());
        item.setRawDataPath(task.getRawDataPath());
        item.setResultCount(results.size());
        item.setErrorMessage(task.getErrorMessage());
        item.setCreatedAt(task.getCreatedAt());
        item.setUpdatedAt(task.getUpdatedAt());
        if (!results.isEmpty()) {
            InferenceResult first = results.get(0);
            item.setActionLabelName(first.getActionLabelName());
            item.setQualityLevel(first.getQualityLevel());
            item.setQualityScore(first.getQualityScore());
            item.setCoachingAdvice(first.getCoachingAdvice());
            item.setAiCoachAdvice(first.getAiCoachAdvice());
        }
        return item;
    }

    private InferenceResultItem toResultItem(InferenceResult result) {
        return new InferenceResultItem(
            result.getSampleIndex(),
            result.getActionLabelId(),
            result.getActionLabelName(),
            result.getConfidence(),
            result.getQualityScore(),
            result.getQualityLevel(),
            result.getCoachingAdvice(),
            result.getAiCoachAdvice(),
            result.getRawResultJson(),
            result.getCreatedAt()
        );
    }
}
