package com.menix.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.sql.Connection;
import java.util.concurrent.CompletableFuture;

/** Tries a warm DB connection after the web server is ready, without delaying port binding. */
@Component
public class DatabaseWarmupListener {
    private static final Logger log = LoggerFactory.getLogger(DatabaseWarmupListener.class);
    private final ObjectProvider<DataSource> dataSourceProvider;

    public DatabaseWarmupListener(ObjectProvider<DataSource> dataSourceProvider) {
        this.dataSourceProvider = dataSourceProvider;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void warmDatabaseInBackground() {
        CompletableFuture.runAsync(this::connectWithRetry);
    }

    private void connectWithRetry() {
        for (int attempt = 1; attempt <= 3; attempt++) {
            try (Connection ignored = dataSourceProvider.getObject().getConnection()) {
                log.info("Database warm-up connection succeeded on attempt {}/3", attempt);
                return;
            } catch (Exception ex) {
                log.warn("Database warm-up attempt {}/3 failed ({})", attempt, ex.getClass().getSimpleName());
                if (attempt < 3) {
                    try { Thread.sleep(3_000); }
                    catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
        }
        log.warn("Database warm-up did not connect; database-backed requests may fail until PostgreSQL recovers.");
    }
}
