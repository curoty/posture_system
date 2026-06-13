package com.example.posture.dto;

import java.time.LocalDateTime;
import java.util.List;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class LatestAdviceDto {

    private String taskNo;
    private String sessionId;
    private String status;
    private LocalDateTime createdAt;
    private List<AdviceItem> results;

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class AdviceItem {
        private Integer sampleIndex;
        private String actionLabelName;
        private Double confidence;
        private Double qualityScore;
        private String qualityLevel;
        private String coachingAdvice;
        private String aiCoachAdvice;
    }
}
