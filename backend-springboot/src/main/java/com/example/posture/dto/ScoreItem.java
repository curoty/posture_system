package com.example.posture.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class ScoreItem {

    private Integer sampleIndex;
    private String actionLabelName;
    private Double qualityScore;
    private String qualityLevel;
    private String coachingAdvice;
}
