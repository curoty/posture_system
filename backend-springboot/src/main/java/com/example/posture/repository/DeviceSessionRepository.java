package com.example.posture.repository;

import com.example.posture.constant.SessionStatus;
import com.example.posture.entity.DeviceSession;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface DeviceSessionRepository extends JpaRepository<DeviceSession, Long> {

    Optional<DeviceSession> findBySessionId(String sessionId);

    Optional<DeviceSession> findFirstByStatusOrderByUpdatedAtDesc(SessionStatus status);

    List<DeviceSession> findByStatus(SessionStatus status);
}
