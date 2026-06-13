package com.example.posture.dto;

import java.time.LocalDateTime;
import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class DeviceSessionStatusResponse {

    private String mac;

    private String sessionId;

    private String status;

    private String calibrationStatus;

    private Integer totalFrames;

    private Integer bufferedFrames;

    private LocalDateTime startedAt;

    private LocalDateTime stoppedAt;

    private LocalDateTime lastDataAt;

    private LocalDateTime lastHeartbeatAt;

    private String errorMessage;
}
