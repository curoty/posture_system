package com.example.posture.service;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Service
public class RealtimeStreamService {

    private final List<SseEmitter> emitters = new CopyOnWriteArrayList<>();

    public SseEmitter subscribe() {
        SseEmitter emitter = new SseEmitter(0L);
        emitters.add(emitter);
        emitter.onCompletion(() -> emitters.remove(emitter));
        emitter.onTimeout(() -> emitters.remove(emitter));
        emitter.onError(error -> emitters.remove(emitter));
        sendToEmitter(emitter, "connected", Map.of("status", "connected"));
        return emitter;
    }

    public void publish(String event, Object data) {
        for (SseEmitter emitter : emitters) {
            sendToEmitter(emitter, event, data);
        }
    }

    private void sendToEmitter(SseEmitter emitter, String event, Object data) {
        try {
            emitter.send(SseEmitter.event().name(event).data(data));
        } catch (IOException | IllegalStateException exc) {
            emitters.remove(emitter);
            try {
                emitter.complete();
            } catch (RuntimeException ignored) {
            }
        }
    }
}
