package com.example.posture.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class PredictApiResponse {

    private Boolean success;
    private String filename;
    private String taskNo;
    private PredictData data;
}
