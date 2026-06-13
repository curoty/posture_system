package com.example.posture.service;

import com.example.posture.constant.SensorNodeMapping;
import com.example.posture.dto.FrameDto;
import com.example.posture.dto.JsonInferenceRequest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

@Service
public class RawDataParserService {

    private static final double DEFAULT_FRAME_INTERVAL_SECONDS = 0.02;

    private static final int EXPECTED_IMU_CHANNELS = 6;

    public List<JsonInferenceRequest> parse(String rawText) {
        if (rawText == null || rawText.isBlank()) {
            return List.of();
        }

        // Split by actual newlines first. If only 1 line but multiple MAC:
        // values, split on MAC: boundaries (handles concatenated frames).
        String[] lines = rawText.split("\\R");
        if (lines.length == 1) {
            lines = lines[0].trim().split("(?=MAC:)");
        }
        List<ParsedFrame> parsedFrames = new ArrayList<>();

        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            ParsedFrame parsed = parseLine(trimmed);
            if (parsed != null && parsed.mac != null && !parsed.payload.isEmpty()) {
                parsedFrames.add(parsed);
            }
        }

        if (parsedFrames.isEmpty()) {
            return List.of();
        }

        Map<String, List<ParsedFrame>> grouped = parsedFrames.stream()
            .collect(Collectors.groupingBy(
                p -> p.mac,
                LinkedHashMap::new,
                Collectors.toList()
            ));

        double baseTime = Instant.now().toEpochMilli() / 1000.0;
        List<JsonInferenceRequest> requests = new ArrayList<>();

        for (Map.Entry<String, List<ParsedFrame>> entry : grouped.entrySet()) {
            String mac = entry.getKey();
            List<ParsedFrame> frames = entry.getValue();
            int n = frames.size();

            List<FrameDto> frameDtoList = new ArrayList<>(n);
            for (int i = 0; i < n; i++) {
                double t = baseTime - (n - 1 - i) * DEFAULT_FRAME_INTERVAL_SECONDS;
                frameDtoList.add(new FrameDto(t, frames.get(i).payload));
            }

            requests.add(new JsonInferenceRequest(mac, null, frameDtoList, null, null));
        }

        return requests;
    }

    private ParsedFrame parseLine(String line) {
        String content = line.endsWith("|") ? line.substring(0, line.length() - 1) : line;
        String[] segments = content.split("\\|");

        String mac = null;
        Map<String, List<Double>> payload = new LinkedHashMap<>();

        for (String segment : segments) {
            int colonIndex = segment.indexOf(':');
            if (colonIndex < 0) {
                continue;
            }
            String key = segment.substring(0, colonIndex).trim();
            String value = segment.substring(colonIndex + 1).trim();

            if ("MAC".equalsIgnoreCase(key)) {
                mac = value;
                continue;
            }

            String mappedName = SensorNodeMapping.MAPPING.get(key);
            if (mappedName == null) {
                continue;
            }
            List<Double> imuValues = parseImuValues(value);
            if (imuValues.size() != EXPECTED_IMU_CHANNELS) {
                continue;
            }
            payload.put(mappedName, imuValues);
        }

        return new ParsedFrame(mac, payload);
    }

    private List<Double> parseImuValues(String value) {
        String[] parts = value.split(",");
        List<Double> values = new ArrayList<>(parts.length);
        for (String part : parts) {
            try {
                values.add(Double.parseDouble(part.trim()));
            } catch (NumberFormatException ignored) {
                return List.of();
            }
        }
        return values;
    }

    private static class ParsedFrame {
        final String mac;
        final Map<String, List<Double>> payload;

        ParsedFrame(String mac, Map<String, List<Double>> payload) {
            this.mac = mac;
            this.payload = payload;
        }
    }
}
