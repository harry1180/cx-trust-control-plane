"""Official Python SDK for the CX Trust Control Plane API.

    from cxtrust import CxTrustClient
    trust = CxTrustClient("http://localhost:8787", api_key="...")

    trust.start_session(organization_id="org-demo")
    trust.stream_transcript(iid, participant_id="p1", text="...", offset_s=0)
    d = trust.evaluate_action(iid, requested_action="ISSUE_REFUND",
                              participant_id="p1", amount=25000)
    if d["decision"]["allowed"]:
        execute()
    else:
        enforce(d["decision"])
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Any


class CxTrustError(RuntimeError):
    pass


class CxTrustClient:
    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 10.0):
        self.base = base_url.rstrip("/")
        self.key = api_key
        self.timeout = timeout

    def _req(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=data,
            method=method,
            headers={
                "content-type": "application/json",
                **({"x-api-key": self.key} if self.key else {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raise CxTrustError(f"{method} {path} -> {e.code}: {e.read().decode()}") from e

    # ---- sessions ----
    def start_session(self, interaction_id: str | None = None, organization_id: str = "org-demo",
                      platform: str = "websocket-voice-ai", channel: str = "voice",
                      metadata: dict | None = None) -> dict:
        return self._req("POST", "/v1/interactions", {
            "interactionId": interaction_id, "organizationId": organization_id,
            "platform": platform, "channel": channel, "metadata": metadata or {},
        })

    def register_participant(self, interaction_id: str, participant: dict) -> dict:
        return self._req("POST", f"/v1/interactions/{interaction_id}/participant", participant)

    def stream_transcript(self, interaction_id: str, participant_id: str, text: str,
                          offset_s: float = 0.0, partial: bool = False) -> dict:
        return self._req("POST", f"/v1/interactions/{interaction_id}/turns", {
            "participantId": participant_id, "text": text, "offsetS": offset_s, "partial": partial,
        })

    def stream_voice_analysis(self, interaction_id: str, participant_id: str,
                              synthetic_probability: float, replay_probability: float,
                              impersonation_probability: float) -> dict:
        return self._req("POST", f"/v1/interactions/{interaction_id}/voice", {
            "participantId": participant_id,
            "syntheticProbability": synthetic_probability,
            "replayProbability": replay_probability,
            "impersonationProbability": impersonation_probability,
        })

    def authentication(self, interaction_id: str, participant_id: str,
                       result: str, level: str = "HIGH") -> dict:
        return self._req("POST", f"/v1/interactions/{interaction_id}/auth", {
            "participantId": participant_id, "result": result, "level": level,
        })

    def evaluate_action(self, interaction_id: str, requested_action: str,
                        participant_id: str, amount: float | None = None,
                        resource: str | None = None, intent: str | None = None,
                        tool: str | None = None) -> dict:
        return self._req("POST", f"/v1/interactions/{interaction_id}/actions", {
            "requestedAction": requested_action, "participantId": participant_id,
            "amount": amount, "resource": resource, "intent": intent, "tool": tool,
        })

    def end_session(self, interaction_id: str) -> dict:
        return self._req("POST", f"/v1/interactions/{interaction_id}/end")

    # ---- reads ----
    def get_interaction(self, interaction_id: str) -> dict:
        return self._req("GET", f"/v1/interactions/{interaction_id}")

    def get_timeline(self, interaction_id: str) -> dict:
        return self._req("GET", f"/v1/interactions/{interaction_id}/timeline")

    def get_evidence(self, interaction_id: str) -> dict:
        return self._req("GET", f"/v1/interactions/{interaction_id}/evidence")

    def get_decisions(self, interaction_id: str) -> dict:
        return self._req("GET", f"/v1/interactions/{interaction_id}/decisions")

    def list_incidents(self) -> dict:
        return self._req("GET", "/v1/incidents")

    def list_agents(self) -> dict:
        return self._req("GET", "/v1/agents")

    def usage(self, organization_id: str) -> dict:
        return self._req("GET", f"/v1/usage/{organization_id}")
