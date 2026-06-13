package com.example.posture.dto;

import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class DeviceDataIngestResponse {

    private String sessionId;

    private String status;

    private Integer receivedFrames;

    private Integer bufferedFrames;

    private Integer generatedTasks;
}
