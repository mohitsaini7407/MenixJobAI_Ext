package com.menix.api;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class HealthController {
    private final ObjectProvider<JdbcTemplate> jdbcTemplateProvider;

    public HealthController(ObjectProvider<JdbcTemplate> jdbcTemplateProvider) { this.jdbcTemplateProvider = jdbcTemplateProvider; }

    /** Liveness endpoint deliberately performs no database or provider calls. */
    @GetMapping("/health")
    public Map<String, String> health() { return Map.of("status", "ok", "app", "MenixJobAI API"); }

    @GetMapping("/health/deep")
    public ResponseEntity<Map<String, String>> deepHealth() {
        try {
            jdbcTemplateProvider.getObject().queryForObject("SELECT 1", Integer.class);
            return ResponseEntity.ok(Map.of("status", "ok", "database", "ok"));
        } catch (Exception ex) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("status", "degraded", "database", "unavailable"));
        }
    }
}
