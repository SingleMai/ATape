package main

import (
	"strings"
	"testing"
)

func TestLoadConfigRequiresDurableStorageOutsideDemoMode(t *testing.T) {
	t.Setenv("ATAPE_SERVER_ADDRESS", "")
	t.Setenv("ATAPE_DATABASE_URL", "")
	t.Setenv("ATAPE_RAW_DIRECTORY", "")
	t.Setenv("ATAPE_DEMO_MODE", "")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "ATAPE_DATABASE_URL is required") {
		t.Fatalf("loadConfig error = %v, want missing database failure", err)
	}
}

func TestLoadConfigAllowsExplicitDemoMode(t *testing.T) {
	t.Setenv("ATAPE_SERVER_ADDRESS", "")
	t.Setenv("ATAPE_DATABASE_URL", "")
	t.Setenv("ATAPE_RAW_DIRECTORY", "")
	t.Setenv("ATAPE_DEMO_MODE", "true")

	config, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if !config.demoMode || config.address != "127.0.0.1:8080" {
		t.Fatalf("unexpected demo config: %+v", config)
	}
}

func TestLoadConfigUsesPostgresWithoutDemoMode(t *testing.T) {
	t.Setenv("ATAPE_SERVER_ADDRESS", "0.0.0.0:8080")
	t.Setenv("ATAPE_DATABASE_URL", "postgres://atape@database/atape")
	t.Setenv("ATAPE_RAW_DIRECTORY", "/var/lib/atape/raw")
	t.Setenv("ATAPE_DEMO_MODE", "false")

	config, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.demoMode || config.address != "0.0.0.0:8080" ||
		config.databaseURL != "postgres://atape@database/atape" ||
		config.rawDirectory != "/var/lib/atape/raw" {
		t.Fatalf("unexpected production config: %+v", config)
	}
}

func TestLoadConfigRejectsInvalidDemoMode(t *testing.T) {
	t.Setenv("ATAPE_DATABASE_URL", "")
	t.Setenv("ATAPE_DEMO_MODE", "sometimes")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "ATAPE_DEMO_MODE must be a boolean") {
		t.Fatalf("loadConfig error = %v, want invalid boolean failure", err)
	}
}
