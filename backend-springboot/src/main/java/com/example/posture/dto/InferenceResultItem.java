package com.example.posture.dto;

import java.time.LocalDateTime;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class InferenceResultItem {

    private Integer sampleIndex;
    private Integer actionLabelId;
    private String actionLabelName;
    private Double confidence;
    private Double qualityScore;
    private String qualityLevel;
    private String coachingAdvice;
    private String aiCoachAdvice;
    private String rawResultJson;
    private LocalDateTime createdAt;
}
