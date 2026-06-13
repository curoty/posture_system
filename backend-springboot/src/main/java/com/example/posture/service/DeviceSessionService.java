package com.example.posture.service;

import com.example.posture.constant.CalibrationStatus;
import com.example.posture.constant.SensorNodeMapping;
import com.example.posture.constant.SessionStatus;
import com.example.posture.dto.DeviceCommandRequest;
import com.example.posture.dto.DeviceCommandResponse;
import com.example.posture.dto.DeviceDataIngestResponse;
import com.example.posture.dto.DeviceSessionStatusResponse;
import com.example.posture.dto.FrameDto;
import com.example.posture.dto.JsonInferenceRequest;
import com.example.posture.entity.DeviceSession;
import com.example.posture.repository.DeviceSessionRepository;
import jakarta.annotation.PostConstruct;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class DeviceSessionService {

    private static final Logger log = LoggerFactory.getLogger(DeviceSessionService.class);

    private final DeviceSessionRepository deviceSessionRepository;
    private final InferenceStreamProducer inferenceStreamProducer;
    private final RealtimeStreamService realtimeStreamService;
    private final SessionStateStore stateStore;
    private final String defaultMac;
    private final double inferenceWindowSeconds;
    private final double inferenceStepSeconds;
    private final double minNodeCompletenessRatio;
    private final boolean timestampIsMilliseconds;

    private final Object monitor = new Object();

    public DeviceSessionService(
        DeviceSessionRepository deviceSessionRepository,
        InferenceStreamProducer inferenceStreamProducer,
        RealtimeStreamService realtimeStreamService,
        SessionStateStore stateStore,
        @Value("${app.hardware.device-id:device-001}") String defaultMac,
        @Value("${app.hardware.inference.window-seconds:4.0}") double inferenceWindowSeconds,
        @Value("${app.hardware.inference.step-seconds:2.0}") double inferenceStepSeconds,
        @Value("${app.hardware.inference.min-node-completeness-ratio:0.7}") double minNodeCompletenessRatio,
        @Value("${app.hardware.timestamp-unit:ms}") String timestampUnit
    ) {
        this.deviceSessionRepository = deviceSessionRepository;
        this.inferenceStreamProducer = inferenceStreamProducer;
        this.realtimeStreamService = realtimeStreamService;
        this.stateStore = stateStore;
        this.defaultMac = defaultMac;
        this.inferenceWindowSeconds = inferenceWindowSeconds;
        this.inferenceStepSeconds = inferenceStepSeconds;
        this.minNodeCompletenessRatio = minNodeCompletenessRatio;
        this.timestampIsMilliseconds = "ms".equalsIgnoreCase(timestampUnit);
    }

    @PostConstruct
    public void repairStaleSessionsOnStartup() {
        List<DeviceSession> staleSessions = deviceSessionRepository.findByStatus(SessionStatus.COLLECTING);
        if (staleSessions.isEmpty()) {
            return;
        }
        for (DeviceSession session : staleSessions) {
            session.setStatus(SessionStatus.IDLE);
            session.setStoppedAt(LocalDateTime.now());
            session.setErrorMessage("服务重启，会话自动终止");
            deviceSessionRepository.save(session);

            stateStore.clearFrames(session.getSessionId());
            stateStore.clearActiveSession(session.getDeviceId());
            stateStore.clearLastInferenceEnd(session.getSessionId());
        }
    }

    public DeviceCommandResponse start(DeviceCommandRequest request) {
        String mac = resolveMac(request);
        String sessionId = resolveRequestedSessionId(request);

        DeviceSession session;
        synchronized (monitor) {
            DeviceSession current = getLatestCollectingSession();
            if (current != null) {
                throw new IllegalStateException("A collection session is already active: " + current.getSessionId());
            }

            session = new DeviceSession();
            session.setSessionId(sessionId);
            session.setDeviceId(mac);
            session.setStatus(SessionStatus.COLLECTING);
            session.setCalibrationStatus(CalibrationStatus.PENDING);
            session.setStartedAt(LocalDateTime.now());
            session.setFrameCount(0);
            session.setErrorMessage(null);
            session = deviceSessionRepository.save(session);

            stateStore.setActiveSession(mac, session.getSessionId());
            stateStore.clearFrames(session.getSessionId());
            stateStore.clearLastInferenceEnd(session.getSessionId());
        }

        publishStatus(session);
        realtimeStreamService.publish(
            "device-command",
            Map.of(
                "mac", mac,
                "sessionId", session.getSessionId(),
                "command", "start",
                "controlMode", "soft"
            )
        );
        return new DeviceCommandResponse(mac, session.getSessionId(), "start", session.getStatus().name(), "soft collection started");
    }

    public DeviceCommandResponse stop(DeviceCommandRequest request) {
        DeviceSession session = requireActiveSession();
        session.setStatus(SessionStatus.IDLE);
        session.setStoppedAt(LocalDateTime.now());
        session.setErrorMessage(null);
        session = deviceSessionRepository.save(session);

        synchronized (monitor) {
            stateStore.clearFrames(session.getSessionId());
            stateStore.clearActiveSession(session.getDeviceId());
            stateStore.clearLastInferenceEnd(session.getSessionId());
        }

        publishStatus(session);
        realtimeStreamService.publish(
            "device-command",
            Map.of(
                "mac", session.getDeviceId(),
                "sessionId", session.getSessionId(),
                "command", "stop",
                "controlMode", "soft"
            )
        );
        return new DeviceCommandResponse(
            session.getDeviceId(),
            session.getSessionId(),
            "stop",
            session.getStatus().name(),
            "soft collection stopped"
        );
    }

    public DeviceDataIngestResponse ingestData(JsonInferenceRequest request) {
        List<FrameDto> frames = request == null ? null : request.getFrames();
        if (frames == null || frames.isEmpty()) {
            throw new IllegalArgumentException("frames must not be empty");
        }
        if (request.getMac() == null || request.getMac().isBlank()) {
            throw new IllegalArgumentException("mac must not be empty");
        }

        DeviceSession session = getLatestCollectingSession();
        if (session == null) {
            realtimeStreamService.publish(
                "device-data-ignored",
                Map.of(
                    "mac", request.getMac(),
                    "sessionId", request.getSessionId(),
                    "receivedFrames", frames.size(),
                    "reason", "soft_control_idle"
                )
            );
            return new DeviceDataIngestResponse(
                request.getSessionId(),
                SessionStatus.IDLE.name(),
                frames.size(),
                0,
                0
            );
        }
        if (!request.getMac().equals(session.getDeviceId())) {
            realtimeStreamService.publish(
                "device-data-ignored",
                Map.of(
                    "mac", request.getMac(),
                    "sessionId", request.getSessionId(),
                    "receivedFrames", frames.size(),
                    "reason", "mac_mismatch"
                )
            );
            return new DeviceDataIngestResponse(
                request.getSessionId(),
                session.getStatus().name(),
                frames.size(),
                currentBufferedFrames(),
                0
            );
        }
        if (request.getSessionId() != null && !request.getSessionId().isBlank()
            && !request.getSessionId().equals(session.getSessionId())) {
            realtimeStreamService.publish(
                "device-data-ignored",
                Map.of(
                    "mac", request.getMac(),
                    "sessionId", request.getSessionId(),
                    "receivedFrames", frames.size(),
                    "reason", "session_mismatch"
                )
            );
            return new DeviceDataIngestResponse(
                request.getSessionId(),
                session.getStatus().name(),
                frames.size(),
                currentBufferedFrames(),
                0
            );
        }

        List<JsonInferenceRequest> inferenceRequests = new ArrayList<>();
        int bufferedFrames;
        synchronized (monitor) {
            String activeSid = stateStore.getActiveSession(session.getDeviceId());
            if (!Objects.equals(activeSid, session.getSessionId())) {
                throw new IllegalStateException("No active buffer is attached to the current session");
            }

            List<FrameDto> currentFrames = stateStore.getFrames(session.getSessionId());
            currentFrames.addAll(copyFrames(frames));
            trimBuffer(currentFrames);
            stateStore.replaceFrames(session.getSessionId(), currentFrames);
            bufferedFrames = currentFrames.size();

            inferenceRequests.addAll(
                buildInferenceRequests(session.getDeviceId(), session.getSessionId(), currentFrames)
            );
        }

        session.setFrameCount(session.getFrameCount() + frames.size());
        session.setLastDataAt(LocalDateTime.now());
        session.setCalibrationStatus(CalibrationStatus.READY);
        session.setErrorMessage(null);
        session = deviceSessionRepository.save(session);

        realtimeStreamService.publish(
            "device-data",
            Map.of(
                "mac", session.getDeviceId(),
                "sessionId", session.getSessionId(),
                "receivedFrames", frames.size(),
                "bufferedFrames", bufferedFrames,
                "frames", frames
            )
        );

        int generatedTasks = 0;
        for (JsonInferenceRequest inferenceRequest : inferenceRequests) {
            inferenceStreamProducer.publish(inferenceRequest);
            generatedTasks++;
        }

        publishStatus(session);
        return new DeviceDataIngestResponse(
            session.getSessionId(),
            session.getStatus().name(),
            frames.size(),
            bufferedFrames,
            generatedTasks
        );
    }

    public DeviceSessionStatusResponse heartbeat(Map<String, Object> payload) {
        DeviceSession session = requireActiveSession();
        session.setLastHeartbeatAt(LocalDateTime.now());
        session.setErrorMessage(null);
        session = deviceSessionRepository.save(session);
        realtimeStreamService.publish(
            "device-heartbeat",
            Map.of(
                "mac", session.getDeviceId(),
                "sessionId", session.getSessionId(),
                "payload", payload == null ? Map.of() : payload
            )
        );
        publishStatus(session);
        return toStatusResponse(session, currentBufferedFrames());
    }

    public DeviceSessionStatusResponse currentStatus() {
        DeviceSession active = getLatestCollectingSession();
        if (active != null) {
            return toStatusResponse(active, currentBufferedFrames());
        }
        return new DeviceSessionStatusResponse(
            defaultMac,
            null,
            SessionStatus.IDLE.name(),
            null,
            0,
            0,
            null,
            null,
            null,
            null,
            null
        );
    }

    private void publishStatus(DeviceSession session) {
        int frames = stateStore.countFrames(session.getSessionId());
        realtimeStreamService.publish("device-status", toStatusResponse(session, frames));
    }

    private int currentBufferedFrames() {
        DeviceSession active = getLatestCollectingSession();
        if (active == null) {
            return 0;
        }
        return stateStore.countFrames(active.getSessionId());
    }

    private DeviceSessionStatusResponse toStatusResponse(DeviceSession session, int bufferedFrames) {
        return new DeviceSessionStatusResponse(
            session.getDeviceId(),
            session.getSessionId(),
            session.getStatus().name(),
            session.getCalibrationStatus() != null ? session.getCalibrationStatus().name() : null,
            session.getFrameCount(),
            bufferedFrames,
            session.getStartedAt(),
            session.getStoppedAt(),
            session.getLastDataAt(),
            session.getLastHeartbeatAt(),
            session.getErrorMessage()
        );
    }

    private DeviceSession requireActiveSession() {
        DeviceSession session = getLatestCollectingSession();
        if (session == null) {
            throw new IllegalStateException("No active collection session");
        }
        return session;
    }

    private DeviceSession getLatestCollectingSession() {
        return deviceSessionRepository.findFirstByStatusOrderByUpdatedAtDesc(SessionStatus.COLLECTING).orElse(null);
    }

    private String resolveMac(DeviceCommandRequest request) {
        String mac = request == null ? null : request.getMac();
        return mac == null || mac.isBlank() ? defaultMac : mac.trim();
    }

    private String resolveRequestedSessionId(DeviceCommandRequest request) {
        Object value = request == null || request.getPayload() == null ? null : request.getPayload().get("sessionId");
        if (value == null) {
            return "SES-" + UUID.randomUUID().toString().replace("-", "");
        }
        String sessionId = String.valueOf(value).trim();
        return sessionId.isEmpty() ? "SES-" + UUID.randomUUID().toString().replace("-", "") : sessionId;
    }

    private List<FrameDto> copyFrames(List<FrameDto> frames) {
        List<FrameDto> copies = new ArrayList<>(frames.size());
        for (FrameDto frame : frames) {
            copies.add(new FrameDto(frame.getT(), frame.getP()));
        }
        return copies;
    }

    private void trimBuffer(List<FrameDto> frames) {
        double maxKeepSeconds = Math.max(inferenceWindowSeconds * 2.0, inferenceWindowSeconds + inferenceStepSeconds);
        if (frames.isEmpty()) {
            return;
        }
        double latestSeconds = toSeconds(frames.get(frames.size() - 1));
        frames.removeIf(frame -> latestSeconds - toSeconds(frame) > maxKeepSeconds);
    }

    private List<JsonInferenceRequest> buildInferenceRequests(String deviceId, String sessionId, List<FrameDto> frames) {
        List<JsonInferenceRequest> requests = new ArrayList<>();
        if (frames.isEmpty()) {
            return requests;
        }
        double latestSeconds = toSeconds(frames.get(frames.size() - 1));
        double earliestAllowed = latestSeconds - inferenceWindowSeconds;
        List<FrameDto> windowFrames = frames.stream()
            .filter(frame -> toSeconds(frame) >= earliestAllowed)
            .map(this::mapFrameForModel)
            .toList();

        if (windowFrames.size() < 2) {
            return requests;
        }
        double startSeconds = toSeconds(windowFrames.get(0));
        double durationSeconds = latestSeconds - startSeconds;
        if (durationSeconds + 1e-9 < inferenceWindowSeconds) {
            return requests;
        }

        // ── 节点完整性校验 ──
        if (!checkNodeCompleteness(deviceId, sessionId, windowFrames)) {
            stateStore.setLastInferenceEnd(sessionId, latestSeconds);
            return requests;
        }

        Double lastInferenceEndSeconds = stateStore.getLastInferenceEnd(sessionId);
        if (lastInferenceEndSeconds != null && latestSeconds - lastInferenceEndSeconds + 1e-9 < inferenceStepSeconds) {
            return requests;
        }

        stateStore.setLastInferenceEnd(sessionId, latestSeconds);
        requests.add(new JsonInferenceRequest(deviceId, sessionId, windowFrames, null, null));
        return requests;
    }

    private double toSeconds(FrameDto frame) {
        if (frame == null || frame.getT() == null) {
            return 0.0;
        }
        double value = frame.getT();
        return timestampIsMilliseconds ? value / 1000.0 : value;
    }

    private FrameDto mapFrameForModel(FrameDto frame) {
        Map<String, List<Double>> payload = frame == null ? null : frame.getP();
        if (payload == null || payload.isEmpty()) {
            return new FrameDto(frame == null ? null : frame.getT(), payload);
        }

        Map<String, List<Double>> mappedPayload = new LinkedHashMap<>();
        for (Map.Entry<String, List<Double>> entry : payload.entrySet()) {
            String mappedName = SensorNodeMapping.MAPPING.get(entry.getKey());
            if (mappedName != null) {
                mappedPayload.put(mappedName, entry.getValue());
            }
        }
        return new FrameDto(frame.getT(), mappedPayload);
    }

    /**
     * 检查推理窗口内帧的节点完整性。
     *
     * @return {@code true} 如果满足阈值，可以继续推理；{@code false} 需要跳过。
     */
    private boolean checkNodeCompleteness(String deviceId, String sessionId, List<FrameDto> windowFrames) {
        Set<String> requiredNodes = SensorNodeMapping.REQUIRED_NODES;
        int completeFrameCount = 0;
        for (FrameDto frame : windowFrames) {
            Map<String, List<Double>> payload = frame.getP();
            if (payload != null && payload.keySet().containsAll(requiredNodes)) {
                completeFrameCount++;
            }
        }

        double completenessRatio = windowFrames.isEmpty()
            ? 0.0
            : (double) completeFrameCount / windowFrames.size();

        if (completenessRatio >= minNodeCompletenessRatio) {
            return true;
        }

        log.warn("推理跳过 — 节点完整性 {}% 低于阈值 {}% (session={}, {} / {} 帧完整)",
            Math.round(completenessRatio * 100), Math.round(minNodeCompletenessRatio * 100),
            sessionId, completeFrameCount, windowFrames.size());

        Map<String, Object> warning = new LinkedHashMap<>();
        warning.put("type", "NODE_INCOMPLETE");
        warning.put("sessionId", sessionId);
        warning.put("deviceId", deviceId);
        warning.put("message", String.format(
            "节点完整性不足，当前仅 %.0f%% 的帧包含全部 9 个节点（要求 ≥%.0f%%），已跳过本轮推理。请检查传感器佩戴状态。",
            completenessRatio * 100, minNodeCompletenessRatio * 100));
        warning.put("completenessRatio", completenessRatio);
        warning.put("threshold", minNodeCompletenessRatio);
        warning.put("completeFrames", completeFrameCount);
        warning.put("totalFrames", windowFrames.size());
        warning.put("requiredNodes", requiredNodes);
        realtimeStreamService.publish("inference-warning", warning);

        return false;
    }
}
