package com.example.posture.entity;

import com.example.posture.constant.InputType;
import com.example.posture.constant.TaskStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
@Entity
@Table(
    name = "inference_task",
    indexes = {
        @Index(name = "idx_inference_task_created_at", columnList = "created_at"),
        @Index(name = "idx_inference_task_session_id", columnList = "session_id")
    }
)
public class InferenceTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "task_no", nullable = false, unique = true, length = 64)
    private String taskNo;

    @Column(name = "user_id")
    private Long userId;

    @Column(name = "session_id", length = 128)
    private String sessionId;

    @Enumerated(EnumType.STRING)
    @Column(name = "input_type", nullable = false, length = 32)
    private InputType inputType;

    @Column(name = "raw_data_path", length = 500)
    private String rawDataPath;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    private TaskStatus status;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;

    @PrePersist
    public void prePersist() {
        LocalDateTime now = LocalDateTime.now();
        this.createdAt = now;
        this.updatedAt = now;
    }

    @PreUpdate
    public void preUpdate() {
        this.updatedAt = LocalDateTime.now();
    }
}
