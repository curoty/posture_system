package com.example.posture.dto;

import java.util.Map;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class DeviceCommandRequest {

    private String mac;

    private Map<String, Object> payload;
}
