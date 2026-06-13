package com.example.posture.repository;

import com.example.posture.entity.RawDataFile;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface RawDataFileRepository extends JpaRepository<RawDataFile, Long> {

    Optional<RawDataFile> findFirstByTaskIdOrderByCreatedAtDesc(Long taskId);
}
