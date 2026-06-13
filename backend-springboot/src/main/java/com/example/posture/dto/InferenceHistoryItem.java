package com.example.posture.dto;

import java.time.LocalDateTime;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class InferenceHistoryItem {

    private String taskNo;
    private String sessionId;
    private String inputType;
    private String status;
    private String rawDataPath;
    private Integer resultCount;
    private String errorMessage;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    private String actionLabelName;
    private String qualityLevel;
    private Double qualityScore;
    private String coachingAdvice;
    private String aiCoachAdvice;
}
