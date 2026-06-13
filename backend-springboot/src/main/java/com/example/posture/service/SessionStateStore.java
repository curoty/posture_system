package com.example.posture.service;

import com.example.posture.dto.FrameDto;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class SessionStateStore {

    private static final String KEY_FRAMES = "session:frames:%s";
    private static final String KEY_ACTIVE = "session:active:%s";
    private static final String KEY_LAST_INFERENCE = "session:last-inference:%s";
    private static final Duration TTL = Duration.ofHours(2);

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public SessionStateStore(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    // ── Frame buffer ──

    public List<FrameDto> getFrames(String sessionId) {
        String key = framesKey(sessionId);
        List<String> values = redis.opsForList().range(key, 0, -1);
        if (values == null || values.isEmpty()) {
            return new ArrayList<>();
        }
        return values.stream()
            .map(this::deserializeFrame)
            .filter(Objects::nonNull)
            .collect(Collectors.toCollection(ArrayList::new));
    }

    public void replaceFrames(String sessionId, List<FrameDto> frames) {
        String key = framesKey(sessionId);
        redis.delete(key);
        if (frames.isEmpty()) {
            return;
        }
        String[] jsonFrames = frames.stream()
            .map(this::serializeFrame)
            .toArray(String[]::new);
        redis.opsForList().rightPushAll(key, jsonFrames);
        redis.expire(key, TTL);
    }

    public int countFrames(String sessionId) {
        Long size = redis.opsForList().size(framesKey(sessionId));
        return size == null ? 0 : size.intValue();
    }

    public void clearFrames(String sessionId) {
        redis.delete(framesKey(sessionId));
    }

    // ── Active session mapping ──

    public void setActiveSession(String deviceId, String sessionId) {
        redis.opsForValue().set(activeKey(deviceId), sessionId, TTL);
    }

    public String getActiveSession(String deviceId) {
        return redis.opsForValue().get(activeKey(deviceId));
    }

    public void clearActiveSession(String deviceId) {
        redis.delete(activeKey(deviceId));
    }

    // ── Last inference end ──

    public void setLastInferenceEnd(String sessionId, Double seconds) {
        String key = lastInferenceKey(sessionId);
        if (seconds == null) {
            redis.delete(key);
        } else {
            redis.opsForValue().set(key, String.valueOf(seconds), TTL);
        }
    }

    public Double getLastInferenceEnd(String sessionId) {
        String value = redis.opsForValue().get(lastInferenceKey(sessionId));
        if (value == null) {
            return null;
        }
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public void clearLastInferenceEnd(String sessionId) {
        redis.delete(lastInferenceKey(sessionId));
    }

    // ── Key helpers ──

    private String framesKey(String sessionId) {
        return String.format(KEY_FRAMES, sessionId);
    }

    private String activeKey(String deviceId) {
        return String.format(KEY_ACTIVE, deviceId);
    }

    private String lastInferenceKey(String sessionId) {
        return String.format(KEY_LAST_INFERENCE, sessionId);
    }

    // ── Serialization ──

    private String serializeFrame(FrameDto frame) {
        try {
            return objectMapper.writeValueAsString(frame);
        } catch (JacksonException e) {
            throw new RuntimeException("Failed to serialize frame", e);
        }
    }

    private FrameDto deserializeFrame(String json) {
        try {
            return objectMapper.readValue(json, FrameDto.class);
        } catch (JacksonException e) {
            return null;
        }
    }
}
