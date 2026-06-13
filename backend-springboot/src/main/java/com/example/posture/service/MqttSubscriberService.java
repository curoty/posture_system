package com.example.posture.service;

import com.example.posture.dto.JsonInferenceRequest;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.util.List;
import org.eclipse.paho.client.mqttv3.IMqttMessageListener;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class MqttSubscriberService {

    private static final Logger log = LoggerFactory.getLogger(MqttSubscriberService.class);

    private final String brokerUrl;
    private final String clientId;
    private final String topic;
    private final MqttConnectOptions options;
    private final RawDataParserService rawDataParserService;
    private final DeviceSessionService deviceSessionService;

    private MqttClient client;

    public MqttSubscriberService(
        @Value("${app.mqtt.broker-url}") String brokerUrl,
        @Value("${app.mqtt.client-id}") String clientId,
        @Value("${app.mqtt.topic}") String topic,
        MqttConnectOptions options,
        RawDataParserService rawDataParserService,
        DeviceSessionService deviceSessionService
    ) {
        this.brokerUrl = brokerUrl;
        this.clientId = clientId;
        this.topic = topic;
        this.options = options;
        this.rawDataParserService = rawDataParserService;
        this.deviceSessionService = deviceSessionService;
    }

    @PostConstruct
    public void connect() {
        try {
            client = new MqttClient(brokerUrl, clientId);
            client.connect(options);
            client.subscribe(topic, handleMessage());
        } catch (MqttException e) {
            log.warn("MQTT broker 连接失败 (broker={}, clientId={})，将通过 automaticReconnect 自动重试: {}",
                brokerUrl, clientId, e.getMessage());
        }
    }

    @PreDestroy
    public void disconnect() {
        if (client != null && client.isConnected()) {
            try {
                client.disconnect();
            } catch (MqttException e) {
                log.warn("MQTT disconnect 失败 (clientId={}): {}", clientId, e.getMessage());
            }
        }
    }

    private IMqttMessageListener handleMessage() {
        return (topic, message) -> {
            String payload = new String(message.getPayload());
            List<JsonInferenceRequest> requests = rawDataParserService.parse(payload);
            for (JsonInferenceRequest request : requests) {
                try {
                    deviceSessionService.ingestData(request);
                } catch (Exception e) {
                    String preview = payload.length() > 200 ? payload.substring(0, 200) + "..." : payload;
                    log.warn("MQTT 消息处理失败 (topic={}, payload[0..200]={}): {}",
                        topic, preview, e.toString(), e);
                }
            }
        };
    }
}
