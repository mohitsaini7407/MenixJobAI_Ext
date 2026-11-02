package com.menix.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;

import javax.sql.DataSource;

@Configuration
public class DataSourceConfig {
    private static final Logger log = LoggerFactory.getLogger(DataSourceConfig.class);

    @Bean(destroyMethod = "close")
    @Primary
    DataSource dataSource(DataSourceProperties properties, Environment environment) {
        RuntimeException lastFailure = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                HikariConfig config = new HikariConfig();
                config.setJdbcUrl(properties.determineUrl());
                if (properties.getUsername() != null) config.setUsername(properties.getUsername());
                if (properties.getPassword() != null) config.setPassword(properties.getPassword());
                if (properties.getDriverClassName() != null) config.setDriverClassName(properties.getDriverClassName());
                config.setConnectionTimeout(environment.getProperty("spring.datasource.hikari.connection-timeout", Long.class, 10_000L));
                config.setMaximumPoolSize(environment.getProperty("spring.datasource.hikari.maximum-pool-size", Integer.class, 5));
                config.setPoolName("MenixJobAI-Hikari");
                return new HikariDataSource(config);
            } catch (RuntimeException ex) {
                lastFailure = ex;
                log.warn("Database connection startup attempt {}/3 failed ({})", attempt, ex.getClass().getSimpleName());
                if (attempt < 3) {
                    try { Thread.sleep(3_000); }
                    catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("Database startup retry was interrupted.");
                    }
                }
            }
        }
        throw new IllegalStateException("Could not connect to the configured database after 3 attempts.", lastFailure);
    }
}
