package com.example.posture.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
@Entity
@Table(
    name = "inference_result",
    indexes = {
        @Index(name = "idx_inference_result_task_id", columnList = "task_id")
    }
)
public class InferenceResult {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "task_id", nullable = false)
    private Long taskId;

    @Column(name = "sample_index", nullable = false)
    private Integer sampleIndex;

    @Column(name = "action_label_id")
    private Integer actionLabelId;

    @Column(name = "action_label_name", length = 100)
    private String actionLabelName;

    @Column(name = "confidence")
    private Double confidence;

    @Column(name = "quality_score")
    private Double qualityScore;

    @Column(name = "quality_level", length = 50)
    private String qualityLevel;

    @Column(name = "coaching_advice", columnDefinition = "TEXT")
    private String coachingAdvice;

    @Column(name = "ai_coach_advice", columnDefinition = "TEXT")
    private String aiCoachAdvice;

    @Column(name = "raw_result_json", columnDefinition = "LONGTEXT")
    private String rawResultJson;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @PrePersist
    public void prePersist() {
        this.createdAt = LocalDateTime.now();
    }
}
