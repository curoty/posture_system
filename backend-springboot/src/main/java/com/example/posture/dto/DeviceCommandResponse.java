package com.example.posture.dto;

import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class DeviceCommandResponse {

    private String mac;

    private String sessionId;

    private String command;

    private String status;

    private String message;
}
