package com.example.posture.controller;

import com.example.posture.dto.InferenceHistoryItem;
import com.example.posture.dto.InferenceResultItem;
import com.example.posture.dto.InferenceTaskDetail;
import com.example.posture.dto.LatestAdviceDto;
import com.example.posture.dto.PageResult;
import com.example.posture.dto.PredictApiResponse;
import com.example.posture.dto.Result;
import com.example.posture.dto.ScoreRequest;
import com.example.posture.service.InferenceService;
import java.io.IOException;
import java.util.List;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/inference")
public class InferenceController {

    private final InferenceService inferenceService;

    public InferenceController(InferenceService inferenceService) {
        this.inferenceService = inferenceService;
    }

    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<PredictApiResponse> upload(@RequestParam("file") MultipartFile file) throws IOException {
        PredictApiResponse response = inferenceService.uploadAndPredict(file);
        return Result.success(response);
    }

    @PostMapping("/json")
    public Result<PredictApiResponse> predictJson(@RequestBody String requestBody) {
        PredictApiResponse response = inferenceService.predictJson(requestBody);
        return Result.success(response);
    }

    @GetMapping("/history")
    public Result<PageResult<InferenceHistoryItem>> history(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return Result.success(inferenceService.listHistory(page, size));
    }

    @GetMapping("/advice/latest")
    public Result<LatestAdviceDto> latestAdvice() {
        LatestAdviceDto advice = inferenceService.getLatestAdvice();
        if (advice == null) {
            return Result.success(null);
        }
        return Result.success(advice);
    }

    @GetMapping("/tasks/{taskNo}")
    public Result<InferenceTaskDetail> taskDetail(@PathVariable String taskNo) {
        return Result.success(inferenceService.getTaskDetail(taskNo));
    }

    @GetMapping("/tasks/{taskNo}/result")
    public Result<List<InferenceResultItem>> taskResults(@PathVariable String taskNo) {
        return Result.success(inferenceService.getTaskResults(taskNo));
    }

    @PutMapping("/tasks/{taskNo}/score")
    public Result<List<InferenceResultItem>> saveScore(@PathVariable String taskNo,
                                                        @RequestBody ScoreRequest request) {
        return Result.success(inferenceService.saveScore(taskNo, request));
    }
}
