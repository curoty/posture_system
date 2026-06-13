package com.example.posture.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class PredictionInfo {

    @JsonProperty("label_id")
    private Integer labelId;

    @JsonProperty("label_name")
    private String labelName;

    private Double confidence;
}
