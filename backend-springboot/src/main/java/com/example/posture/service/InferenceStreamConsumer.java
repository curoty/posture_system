package com.example.posture.service;

import com.example.posture.dto.FrameDto;
import com.example.posture.dto.JsonInferenceRequest;
import com.example.posture.dto.PredictApiResponse;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class InferenceStreamConsumer {

    static final String STREAM_KEY = InferenceStreamProducer.STREAM_KEY;
    private static final String GROUP_NAME = "inference-group";

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final InferenceService inferenceService;
    private final RealtimeStreamService realtimeStreamService;

    private volatile boolean running = true;
    private Thread consumerThread;

    public InferenceStreamConsumer(
        StringRedisTemplate redis,
        ObjectMapper objectMapper,
        InferenceService inferenceService,
        RealtimeStreamService realtimeStreamService
    ) {
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.inferenceService = inferenceService;
        this.realtimeStreamService = realtimeStreamService;
    }

    @PostConstruct
    public void start() {
        try {
            redis.opsForStream().createGroup(STREAM_KEY, GROUP_NAME);
        } catch (Exception ignored) {
            // Group already exists
        }

        consumerThread = new Thread(this::consumeLoop, "inference-consumer");
        consumerThread.setDaemon(true);
        consumerThread.start();
    }

    @PreDestroy
    public void stop() {
        running = false;
        if (consumerThread != null) {
            consumerThread.interrupt();
        }
    }

    private void consumeLoop() {
        String consumerId = "consumer-" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);

        while (running) {
            try {
                @SuppressWarnings("unchecked")
                List<MapRecord<String, Object, Object>> messages = (List) redis.opsForStream()
                    .read(
                        Consumer.from(GROUP_NAME, consumerId),
                        StreamReadOptions.empty().count(5).block(Duration.ofSeconds(2)),
                        StreamOffset.create(STREAM_KEY, ReadOffset.lastConsumed())
                    );

                if (messages == null || messages.isEmpty()) {
                    continue;
                }

                for (MapRecord<String, Object, Object> record : messages) {
                    try {
                        processRecord(record);
                    } catch (Exception e) {
                        // Log and continue — the task itself handles errors internally
                    }
                    redis.opsForStream().acknowledge(STREAM_KEY, GROUP_NAME, record.getId().getValue());
                }
            } catch (Exception e) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
    }

    private void processRecord(MapRecord<String, Object, Object> record) {
        Map<Object, Object> fields = record.getValue();
        String mac = fieldAsString(fields.get("mac"));
        String sessionId = fieldAsString(fields.get("sessionId"));
        String framesJson = fieldAsString(fields.get("frames"));

        List<FrameDto> frames = parseFrames(framesJson);
        JsonInferenceRequest request = new JsonInferenceRequest(mac, sessionId, frames, null, null);

        PredictApiResponse response = inferenceService.predictJson(request);

        Map<String, Object> event = new LinkedHashMap<>();
        event.put("mac", mac);
        event.put("sessionId", sessionId);
        event.put("taskNo", response == null ? null : response.getTaskNo());
        event.put("result", response);
        realtimeStreamService.publish("inference-result", event);
    }

    private List<FrameDto> parseFrames(String json) {
        if (json == null || json.isBlank() || "[]".equals(json)) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<List<FrameDto>>() {});
        } catch (Exception e) {
            return List.of();
        }
    }

    private String fieldAsString(Object value) {
        return value == null ? "" : String.valueOf(value);
    }
}
