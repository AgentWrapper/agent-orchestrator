import XCTest
@testable import AOPet

final class StateAggregatorTests: XCTestCase {
    private func session(_ id: String, _ project: String, _ status: SessionStatus, _ activity: ActivityState? = nil) -> WireSession {
        return WireSession(id: id, projectId: project, status: status, activity: activity)
    }

    // MARK: - Single-session moods

    func testWaitingInputProducesAlert() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .working, .waitingInput)), .alert)
    }

    func testNeedsInputStatusProducesAlert() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .needsInput, .ready)), .alert)
    }

    func testCIFailedProducesSad() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .ciFailed, .ready)), .sad)
    }

    func testStuckProducesSad() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .stuck)), .sad)
    }

    func testBlockedActivityProducesSad() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .working, .blocked)), .sad)
    }

    func testPROpenProducesHappy() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .prOpen, .idle)), .happy)
    }

    func testApprovedProducesHappy() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .approved, .idle)), .happy)
    }

    func testWorkingActivityProducesWorking() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .working, .active)), .working)
    }

    func testIdleSessionProducesSleeping() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .idle, .idle)), .sleeping)
    }

    func testDoneProducesSleeping() {
        XCTAssertEqual(StateAggregator.mood(for: session("s", "p", .done)), .sleeping)
    }

    // MARK: - Worst-state picker

    func testWorstStatePicksAlertOverWorkingAndHappy() {
        let sessions = [
            session("a", "p1", .working, .active),
            session("b", "p1", .prOpen, .idle),
            session("c", "p1", .needsInput, .waitingInput)
        ]
        let projects = StateAggregator.aggregate(sessions: sessions, projectNames: ["p1": "Proj"])
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0].mood, .alert)
        XCTAssertEqual(projects[0].sessionCount, 3)
    }

    func testWorstStatePicksSadOverWorking() {
        let sessions = [
            session("a", "p1", .working, .active),
            session("b", "p1", .ciFailed, .ready)
        ]
        let projects = StateAggregator.aggregate(sessions: sessions, projectNames: [:])
        XCTAssertEqual(projects[0].mood, .sad)
    }

    func testGroupingProducesOneEntryPerProject() {
        let sessions = [
            session("a", "p1", .working, .active),
            session("b", "p1", .working, .active),
            session("c", "p2", .merged)
        ]
        let projects = StateAggregator.aggregate(
            sessions: sessions,
            projectNames: ["p1": "Alpha", "p2": "Beta"]
        )
        XCTAssertEqual(projects.count, 2)
        // Sorted by projectName.
        XCTAssertEqual(projects.map { $0.projectName }, ["Alpha", "Beta"])
        XCTAssertEqual(projects[0].mood, .working)
        XCTAssertEqual(projects[1].mood, .sleeping)
    }

    func testProjectIdFallbackWhenNoNameAvailable() {
        let sessions = [session("a", "no-orch", .working, .active)]
        let projects = StateAggregator.aggregate(sessions: sessions, projectNames: [:])
        XCTAssertEqual(projects[0].projectName, "no-orch")
    }

    func testEmptySessionsProducesNoProjects() {
        XCTAssertTrue(StateAggregator.aggregate(sessions: [], projectNames: [:]).isEmpty)
    }

    func testMoodPriorityOrdering() {
        // Verify the priority ordering that the worst-state picker depends on.
        XCTAssertLessThan(PetMood.sleeping.priority, PetMood.happy.priority)
        XCTAssertLessThan(PetMood.happy.priority, PetMood.working.priority)
        XCTAssertLessThan(PetMood.working.priority, PetMood.sad.priority)
        XCTAssertLessThan(PetMood.sad.priority, PetMood.alert.priority)
    }
}
