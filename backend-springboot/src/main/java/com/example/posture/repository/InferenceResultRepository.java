package com.example.posture.repository;

import com.example.posture.entity.InferenceResult;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface InferenceResultRepository extends JpaRepository<InferenceResult, Long> {

    List<InferenceResult> findByTaskIdOrderBySampleIndexAsc(Long taskId);
}
