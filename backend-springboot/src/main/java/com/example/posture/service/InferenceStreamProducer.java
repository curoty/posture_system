package com.example.posture.service;

import com.example.posture.dto.FrameDto;
import com.example.posture.dto.JsonInferenceRequest;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class InferenceStreamProducer {

    static final String STREAM_KEY = "inference:stream";

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public InferenceStreamProducer(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    public void publish(JsonInferenceRequest request) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("mac", request.getMac() != null ? request.getMac() : "");
        fields.put("sessionId", request.getSessionId() != null ? request.getSessionId() : "");

        List<FrameDto> frames = request.getFrames();
        try {
            fields.put("frames", frames != null ? objectMapper.writeValueAsString(frames) : "[]");
        } catch (JacksonException e) {
            throw new RuntimeException("Failed to serialize frames for stream", e);
        }

        redis.opsForStream().add(STREAM_KEY, fields);
    }
}
