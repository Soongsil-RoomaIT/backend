package kr.ac.roomcare.notification.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.util.Map;
import kr.ac.roomcare.notification.service.NotificationService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/notifications")
public class NotificationController {
    private final NotificationService service;

    NotificationController(NotificationService service) {
        this.service = service;
    }

    @PostMapping("/devices")
    ResponseEntity<Void> register(@Valid @RequestBody DeviceTokenRequest request, JwtAuthenticationToken auth) {
        service.registerToken(auth.getToken().getSubject(), request.token());
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/devices/{token}")
    ResponseEntity<Void> delete(@PathVariable String token, JwtAuthenticationToken auth) {
        service.removeToken(auth.getToken().getSubject(), token);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/send")
    SendResponse send(@Valid @RequestBody SendRequest request) {
        return service.send(request);
    }

    record DeviceTokenRequest(@NotBlank String token) {}
    public record SendRequest(@NotBlank String eventId, @NotBlank String userId, @NotBlank String title,
                              @NotBlank String body, @NotEmpty Map<String, String> data) {}
    public record SendResponse(String eventId, String status, int targetCount) {}
}

