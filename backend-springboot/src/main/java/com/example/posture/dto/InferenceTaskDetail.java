package com.example.posture.dto;

import java.time.LocalDateTime;
import java.util.List;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class InferenceTaskDetail {

    private String taskNo;
    private String sessionId;
    private String inputType;
    private String status;
    private String rawDataPath;
    private Integer frameCount;
    private Long sizeBytes;
    private String errorMessage;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    private List<InferenceResultItem> results;
}
