import test from "node:test";
import assert from "node:assert/strict";
import { isCorsOriginAllowed } from "../config/env";

test("No-Origin request preserved", () => {
    assert.equal(isCorsOriginAllowed("", ["https://example.com"], true), true);
    assert.equal(isCorsOriginAllowed(undefined, ["https://example.com"], true), true);
});

test("Configured public production origin accepted", () => {
    assert.equal(isCorsOriginAllowed("https://khata.sathi.com", ["https://khata.sathi.com"], true), true);
    assert.equal(isCorsOriginAllowed("https://khata.sathi.com/", ["https://khata.sathi.com"], true), true);
});

test("Configured private production origin accepted", () => {
    assert.equal(isCorsOriginAllowed("http://192.168.1.100", ["http://192.168.1.100"], true), true);
});

test("Unconfigured private production origin rejected", () => {
    assert.equal(isCorsOriginAllowed("http://192.168.1.50", ["https://khata.sathi.com"], true), false);
    assert.equal(isCorsOriginAllowed("http://10.0.0.5", ["https://khata.sathi.com"], true), false);
});

test("Unconfigured localhost production origin rejected", () => {
    assert.equal(isCorsOriginAllowed("http://localhost:5173", ["https://khata.sathi.com"], true), false);
    assert.equal(isCorsOriginAllowed("http://127.0.0.1:5173", ["https://khata.sathi.com"], true), false);
});

test("Development local/LAN behavior preserved", () => {
    // When isProduction is false
    assert.equal(isCorsOriginAllowed("http://localhost:5173", ["https://example.com"], false), true);
    assert.equal(isCorsOriginAllowed("http://192.168.1.50:4000", ["https://example.com"], false), true);
    assert.equal(isCorsOriginAllowed("http://10.0.0.5", ["https://example.com"], false), true);
});
