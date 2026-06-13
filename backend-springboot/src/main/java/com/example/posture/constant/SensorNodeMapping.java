package com.example.posture.constant;

import java.util.Map;
import java.util.Set;

public final class SensorNodeMapping {

    /** 全部 9 个语义节点名称（用于节点完整性校验）。 */
    public static final Set<String> REQUIRED_NODES = Set.of(
        "head",
        "left_elbow",
        "left_wrist",
        "right_elbow",
        "right_wrist",
        "left_knee",
        "left_foot",
        "right_knee",
        "right_foot"
    );

    public static final Map<String, String> MAPPING = Map.ofEntries(
        // 硬件 ID → 语义名称
        Map.entry("head", "head"),
        Map.entry("HOST", "head"),
        Map.entry("1A", "left_elbow"),
        Map.entry("1B", "left_wrist"),
        Map.entry("2A", "right_elbow"),
        Map.entry("2B", "right_wrist"),
        Map.entry("3A", "left_knee"),
        Map.entry("3B", "left_foot"),
        Map.entry("4A", "right_knee"),
        Map.entry("4B", "right_foot"),
        // 语义名称 → 语义名称（防止二次映射丢失）
        Map.entry("left_elbow", "left_elbow"),
        Map.entry("left_wrist", "left_wrist"),
        Map.entry("right_elbow", "right_elbow"),
        Map.entry("right_wrist", "right_wrist"),
        Map.entry("left_knee", "left_knee"),
        Map.entry("left_foot", "left_foot"),
        Map.entry("right_knee", "right_knee"),
        Map.entry("right_foot", "right_foot")
    );

    private SensorNodeMapping() {
    }
}
