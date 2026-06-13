package com.example.posture.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class JsonInferenceRequest {

    private String mac;

    @JsonProperty("sessionId")
    private String sessionId;

    private List<FrameDto> frames;

    @JsonProperty("windowSeconds")
    private Double windowSeconds;

    @JsonProperty("stepSeconds")
    private Double stepSeconds;
}
