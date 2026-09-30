package kr.ac.roomcare.notification.service;

import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import kr.ac.roomcare.notification.api.NotificationController.SendRequest;
import kr.ac.roomcare.notification.api.NotificationController.SendResponse;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class NotificationService {
    private static final Duration DEDUP_TTL = Duration.ofHours(24);
    private final StringRedisTemplate redis;
    private final AesGcmCipher cipher;
    private final FcmSender sender;

    NotificationService(StringRedisTemplate redis, AesGcmCipher cipher, FcmSender sender) {
        this.redis = redis;
        this.cipher = cipher;
        this.sender = sender;
    }

    public void registerToken(String userId, String token) {
        redis.opsForHash().put(tokenKey(userId), tokenFingerprint(token), cipher.encrypt(token));
    }

    public void removeToken(String userId, String token) {
        redis.opsForHash().delete(tokenKey(userId), tokenFingerprint(token));
    }

    public SendResponse send(SendRequest request) {
        Boolean first = redis.opsForValue().setIfAbsent("notification:event:" + request.eventId(), "sent", DEDUP_TTL);
        if (!Boolean.TRUE.equals(first)) return new SendResponse(request.eventId(), "DUPLICATE", 0);

        Map<Object, Object> stored = redis.opsForHash().entries(tokenKey(request.userId()));
        if (stored == null || stored.isEmpty()) return new SendResponse(request.eventId(), "NO_TARGET", 0);
        stored.values().stream().map(Object::toString).map(cipher::decrypt)
            .forEach(token -> sender.send(token, request.title(), request.body(), request.data()));
        return new SendResponse(request.eventId(), "SENT", stored.size());
    }

    private String tokenKey(String userId) {
        return "notification:tokens:" + userId;
    }

    private String tokenFingerprint(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }
}

