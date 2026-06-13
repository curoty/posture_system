package com.example.posture.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class PredictResult {

    @JsonProperty("sample_index")
    private Integer sampleIndex;

    private PredictionInfo prediction;

    @JsonProperty("quality_score")
    private Double qualityScore;

    @JsonProperty("quality_level")
    private String qualityLevel;

    @JsonProperty("similarity")
    private Double similarity;

    @JsonProperty("is_standard")
    private Boolean isStandard;

    private List<Map<String, Object>> deviations;

    @JsonProperty("coaching_advice")
    private String coachingAdvice;

    @JsonProperty("ai_coach_advice")
    private String aiCoachAdvice;

    @JsonProperty("top_predictions")
    private List<TopPrediction> topPredictions;
}
