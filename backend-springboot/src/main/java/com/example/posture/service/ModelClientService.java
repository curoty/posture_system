package com.example.posture.service;

import com.example.posture.dto.PredictApiResponse;
import com.example.posture.dto.PredictByPathRequest;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class ModelClientService {

    private final RestTemplate restTemplate;
    private final String predictByPathUrl;
    private final String predictJsonUrl;

    public ModelClientService(
        RestTemplate restTemplate,
        @Value("${app.model-api.base-url:http://127.0.0.1:5000}") String modelApiBaseUrl
    ) {
        this.restTemplate = restTemplate;
        String normalizedBaseUrl = modelApiBaseUrl.replaceAll("/+$", "");
        this.predictByPathUrl = normalizedBaseUrl + "/predict-by-path";
        this.predictJsonUrl = normalizedBaseUrl + "/predict-json";
    }

    public PredictApiResponse predictByPath(String filePath) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        HttpEntity<PredictByPathRequest> requestEntity =
            new HttpEntity<>(new PredictByPathRequest(filePath), headers);
        ResponseEntity<PredictApiResponse> response = restTemplate.postForEntity(
            predictByPathUrl,
            requestEntity,
            PredictApiResponse.class
        );

        return response.getBody();
    }

    public PredictApiResponse predictByJson(Map<String, Object> request) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        HttpEntity<Map<String, Object>> requestEntity = new HttpEntity<>(request, headers);
        ResponseEntity<PredictApiResponse> response = restTemplate.postForEntity(
            predictJsonUrl,
            requestEntity,
            PredictApiResponse.class
        );

        return response.getBody();
    }
}
