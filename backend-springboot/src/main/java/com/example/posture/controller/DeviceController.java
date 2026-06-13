package com.example.posture.controller;

import com.example.posture.dto.DeviceCommandRequest;
import com.example.posture.dto.DeviceCommandResponse;
import com.example.posture.dto.DeviceDataIngestResponse;
import com.example.posture.dto.DeviceSessionStatusResponse;
import com.example.posture.dto.JsonInferenceRequest;
import com.example.posture.dto.Result;
import com.example.posture.service.DeviceSessionService;
import com.example.posture.service.RawDataParserService;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/device")
public class DeviceController {

    private final DeviceSessionService deviceSessionService;
    private final RawDataParserService rawDataParserService;

    public DeviceController(DeviceSessionService deviceSessionService,
                            RawDataParserService rawDataParserService) {
        this.deviceSessionService = deviceSessionService;
        this.rawDataParserService = rawDataParserService;
    }

    @PostMapping("/commands/start")
    public Result<DeviceCommandResponse> start(@RequestBody(required = false) DeviceCommandRequest request) {
        return Result.success(deviceSessionService.start(request));
    }

    @PostMapping("/commands/stop")
    public Result<DeviceCommandResponse> stop(@RequestBody(required = false) DeviceCommandRequest request) {
        return Result.success(deviceSessionService.stop(request));
    }

    @PostMapping("/data")
    public Result<DeviceDataIngestResponse> ingestData(@RequestBody JsonInferenceRequest request) {
        return Result.success(deviceSessionService.ingestData(request));
    }

    @PostMapping("/heartbeat")
    public Result<DeviceSessionStatusResponse> heartbeat(@RequestBody(required = false) Map<String, Object> payload) {
        return Result.success(deviceSessionService.heartbeat(payload));
    }

    @GetMapping("/status")
    public Result<DeviceSessionStatusResponse> status() {
        return Result.success(deviceSessionService.currentStatus());
    }

    @PostMapping(value = "/data/raw", consumes = MediaType.TEXT_PLAIN_VALUE)
    public Result<DeviceDataIngestResponse> ingestRawData(@RequestBody String rawText) {
        List<JsonInferenceRequest> requests = rawDataParserService.parse(rawText);
        if (requests.isEmpty()) {
            throw new IllegalArgumentException("No valid frames found in raw data");
        }
        DeviceDataIngestResponse lastResponse = null;
        for (JsonInferenceRequest request : requests) {
            lastResponse = deviceSessionService.ingestData(request);
        }
        return Result.success(lastResponse);
    }
}
