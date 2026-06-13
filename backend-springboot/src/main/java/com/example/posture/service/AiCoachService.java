package com.example.posture.service;

import com.example.posture.dto.PredictResult;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class AiCoachService {

    private final RestTemplate restTemplate;
    private final boolean enabled;
    private final String baseUrl;
    private final String apiKey;
    private final String model;

    public AiCoachService(
        RestTemplate restTemplate,
        @Value("${app.ai-coach.enabled:false}") boolean enabled,
        @Value("${app.ai-coach.base-url:}") String baseUrl,
        @Value("${app.ai-coach.api-key:}") String apiKey,
        @Value("${app.ai-coach.model:gpt-4o-mini}") String model
    ) {
        this.restTemplate = restTemplate;
        this.enabled = enabled;
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.model = model;
    }

    public String generateAdvice(PredictResult result) {
        String fallback = buildRuleAdvice(result);
        if (!enabled || baseUrl == null || baseUrl.isBlank() || apiKey == null || apiKey.isBlank()) {
            return fallback;
        }

        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(apiKey);

            Map<String, Object> body = Map.of(
                "model", model,
                "messages", List.of(
                    Map.of(
                        "role", "system",
                        "content",
                        "You are an ice-skating motion coach. Respond in concise Chinese. Use only the provided structured data and do not invent sensor details."
                    ),
                    Map.of(
                        "role", "user",
                        "content", buildPrompt(result)
                    )
                ),
                "temperature", 0.3
            );

            @SuppressWarnings("unchecked")
            Map<String, Object> response = restTemplate.postForObject(
                normalizeBaseUrl(baseUrl) + "/chat/completions",
                new HttpEntity<>(body, headers),
                Map.class
            );
            String content = extractContent(response);
            return content == null || content.isBlank() ? fallback : content.trim();
        } catch (RuntimeException exc) {
            return fallback;
        }
    }

    private String buildRuleAdvice(PredictResult result) {
        if (result.getCoachingAdvice() != null && !result.getCoachingAdvice().isBlank()) {
            return result.getCoachingAdvice();
        }
        String action = result.getPrediction() == null ? "\u5f53\u524d\u52a8\u4f5c" : result.getPrediction().getLabelName();
        Double score = result.getQualityScore();
        if (score == null) {
            return "\u5f53\u524d\u52a8\u4f5c\u53ef\u8bc6\u522b\uff0c\u4f46\u8d28\u91cf\u8bc4\u5206\u6682\u4e0d\u53ef\u7528\u3002\u5efa\u8bae\u4fdd\u6301\u5b8c\u6574\u4f20\u611f\u5668\u91c7\u96c6\uff0c\u5e76\u91cd\u590d\u5b8c\u6210\u52a8\u4f5c\u4ee5\u83b7\u5f97\u66f4\u7a33\u5b9a\u7684\u5224\u65ad\u3002";
        }
        if (score < 60.0) {
            return "\u672c\u6b21 " + action + " \u5b8c\u6210\u8d28\u91cf\u504f\u4f4e\u3002\u5efa\u8bae\u5148\u964d\u4f4e\u901f\u5ea6\uff0c\u5206\u89e3\u7ec3\u4e60\u52a8\u4f5c\u8def\u5f84\u3001\u53d1\u529b\u8282\u594f\u548c\u8eab\u4f53\u7a33\u5b9a\u6027\u3002";
        }
        if (score < 75.0) {
            return "\u672c\u6b21 " + action + " \u5b8c\u6210\u8d28\u91cf\u4e00\u822c\u3002\u5efa\u8bae\u91cd\u70b9\u5173\u6ce8\u52a8\u4f5c\u8fde\u8d2f\u6027\uff0c\u4fdd\u6301\u91cd\u5fc3\u7a33\u5b9a\uff0c\u5e76\u5bf9\u7167\u6807\u51c6\u52a8\u4f5c\u4fee\u6b63\u8282\u594f\u3002";
        }
        if (score < 90.0) {
            return "\u672c\u6b21 " + action + " \u5b8c\u6210\u8d28\u91cf\u826f\u597d\u3002\u5efa\u8bae\u7ee7\u7eed\u4f18\u5316\u7ec6\u8282\uff0c\u4fdd\u6301\u5de6\u53f3\u4fa7\u52a8\u4f5c\u4e00\u81f4\u548c\u7a33\u5b9a\u8282\u594f\u3002";
        }
        return "\u672c\u6b21 " + action + " \u5b8c\u6210\u8d28\u91cf\u4f18\u79c0\u3002\u5efa\u8bae\u4fdd\u6301\u5f53\u524d\u52a8\u4f5c\u8282\u594f\uff0c\u5e76\u589e\u52a0\u591a\u6b21\u91cd\u590d\u8bad\u7ec3\u6765\u7a33\u5b9a\u8868\u73b0\u3002";
    }

    private String buildPrompt(PredictResult result) {
        return "Action prediction: " + result.getPrediction()
            + "\nQuality score: " + result.getQualityScore()
            + "\nQuality level: " + result.getQualityLevel()
            + "\nStandard-action deviations: " + result.getDeviations()
            + "\nRule advice: " + result.getCoachingAdvice()
            + "\nPlease output Chinese coaching feedback within 3 sentences, including the main issue and next practice suggestion.";
    }

    private String normalizeBaseUrl(String url) {
        return url.replaceAll("/+$", "");
    }

    private String extractContent(Map<String, Object> response) {
        if (response == null) {
            return null;
        }
        Object choicesValue = response.get("choices");
        if (!(choicesValue instanceof List<?> choices) || choices.isEmpty()) {
            return null;
        }
        Object first = choices.get(0);
        if (!(first instanceof Map<?, ?> firstMap)) {
            return null;
        }
        Object message = firstMap.get("message");
        if (!(message instanceof Map<?, ?> messageMap)) {
            return null;
        }
        Object content = messageMap.get("content");
        return content == null ? null : String.valueOf(content);
    }
}
