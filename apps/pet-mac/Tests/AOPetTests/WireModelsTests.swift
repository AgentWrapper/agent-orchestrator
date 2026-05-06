import XCTest
@testable import AOPet

final class WireModelsTests: XCTestCase {
    func testDecodesSessionsResponseSubset() throws {
        let json = """
        {
          "sessions": [
            {
              "id": "s1",
              "projectId": "p1",
              "status": "working",
              "activity": "active",
              "branch": null,
              "issueId": null,
              "issueUrl": null,
              "issueLabel": null,
              "issueTitle": null,
              "userPrompt": null,
              "displayName": null,
              "summary": null,
              "summaryIsFallback": false,
              "createdAt": "2026-05-07T10:00:00Z",
              "lastActivityAt": "2026-05-07T10:00:00Z",
              "pr": null,
              "metadata": {}
            },
            {
              "id": "s2",
              "projectId": "p2",
              "status": "needs_input",
              "activity": "waiting_input",
              "branch": null,
              "issueId": null,
              "issueUrl": null,
              "issueLabel": null,
              "issueTitle": null,
              "userPrompt": null,
              "displayName": null,
              "summary": null,
              "summaryIsFallback": false,
              "createdAt": "2026-05-07T10:00:00Z",
              "lastActivityAt": "2026-05-07T10:00:00Z",
              "pr": null,
              "metadata": {}
            }
          ],
          "stats": {"totalSessions": 2, "workingSessions": 1, "openPRs": 0, "needsReview": 0},
          "orchestratorId": null,
          "orchestrators": [
            {"id": "orc1", "projectId": "p1", "projectName": "First Project"},
            {"id": "orc2", "projectId": "p2", "projectName": "Second Project"}
          ]
        }
        """.data(using: .utf8)!

        let parsed = try WireDecoder.decodeSessions(json)
        XCTAssertEqual(parsed.sessions.count, 2)
        XCTAssertEqual(parsed.sessions[0].id, "s1")
        XCTAssertEqual(parsed.sessions[0].status, .working)
        XCTAssertEqual(parsed.sessions[0].activity, .active)
        XCTAssertEqual(parsed.sessions[1].status, .needsInput)
        XCTAssertEqual(parsed.sessions[1].activity, .waitingInput)

        let names = parsed.projectNames()
        XCTAssertEqual(names["p1"], "First Project")
        XCTAssertEqual(names["p2"], "Second Project")
    }

    func testTolerantDecodingForUnknownStatus() throws {
        // Future SessionStatus values shouldn't crash the pet — they decode
        // to .unknown and the aggregator falls back to .sleeping.
        let json = """
        {
          "sessions": [
            {"id": "s1", "projectId": "p1", "status": "future_status", "activity": "novel"}
          ],
          "orchestrators": []
        }
        """.data(using: .utf8)!
        let parsed = try WireDecoder.decodeSessions(json)
        XCTAssertEqual(parsed.sessions.first?.status, .unknown)
        XCTAssertEqual(parsed.sessions.first?.activity, .unknown)
    }

    func testDecodesSocketEventLine() throws {
        let line = """
        {"v":1,"kind":"event","event":{"id":"e1","type":"pr_merged","priority":"info","sessionId":"s1","projectId":"p1","timestamp":"2026-05-07T10:00:00Z","message":"PR #42 merged","data":{"pr":42}},"actions":[{"label":"Open PR","action":"open:https://github.com/x/y/pull/42"}]}
        """.data(using: .utf8)!

        let env = try WireDecoder.decodeEvent(line)
        XCTAssertEqual(env.v, 1)
        XCTAssertEqual(env.kind, "event")
        XCTAssertEqual(env.event.id, "e1")
        XCTAssertEqual(env.event.priority, .info)
        XCTAssertEqual(env.event.projectId, "p1")
        XCTAssertEqual(env.event.message, "PR #42 merged")
        XCTAssertEqual(env.actions?.count, 1)
        XCTAssertEqual(env.actions?.first?.label, "Open PR")
    }

    func testEventLineToleratesMissingOptionals() throws {
        // No sessionId / projectId / timestamp / actions — still valid.
        let line = """
        {"v":1,"kind":"event","event":{"id":"e2","type":"system","priority":"warning","message":"dashboard restarted"}}
        """.data(using: .utf8)!

        let env = try WireDecoder.decodeEvent(line)
        XCTAssertEqual(env.event.priority, .warning)
        XCTAssertNil(env.event.projectId)
        XCTAssertNil(env.actions)
    }
}
