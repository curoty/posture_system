package com.example.posture.controller;

import com.example.posture.service.RealtimeStreamService;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/realtime")
public class RealtimeController {

    private final RealtimeStreamService realtimeStreamService;

    public RealtimeController(RealtimeStreamService realtimeStreamService) {
        this.realtimeStreamService = realtimeStreamService;
    }

    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream() {
        return realtimeStreamService.subscribe();
    }
}
