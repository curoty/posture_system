package com.example.posture.repository;

import com.example.posture.entity.InferenceTask;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface InferenceTaskRepository extends JpaRepository<InferenceTask, Long> {

    Optional<InferenceTask> findByTaskNo(String taskNo);

    Page<InferenceTask> findAllByOrderByCreatedAtDesc(Pageable pageable);
}
