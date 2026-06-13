package com.example.posture.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class PredictData {

    private Integer samples;

    @JsonProperty("window_size")
    private Integer windowSize;

    @JsonProperty("step_size")
    private Integer stepSize;

    @JsonProperty("sensor_mode")
    private String sensorMode;

    private List<PredictResult> results;
}
