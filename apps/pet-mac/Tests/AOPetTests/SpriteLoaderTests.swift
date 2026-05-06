import XCTest
@testable import AOPet

final class SpriteLoaderTests: XCTestCase {
    func testLoadsBundledDogSet() throws {
        let set = try XCTUnwrap(SpriteLoader.load("dog"))
        XCTAssertEqual(set.name, "dog")
        // Each animatable mood ships with at least 2 frames.
        for mood in [PetMood.sleeping, .happy, .working, .sad, .alert] {
            XCTAssertGreaterThanOrEqual(
                set.frameCount(for: mood),
                2,
                "expected ≥2 frames for \(mood.rawValue) in dog set"
            )
        }
    }

    func testLoadsBundledCatSet() throws {
        let set = try XCTUnwrap(SpriteLoader.load("cat"))
        XCTAssertEqual(set.name, "cat")
        XCTAssertGreaterThanOrEqual(set.frameCount(for: .working), 2)
    }

    func testReturnsNilForMissingSet() {
        XCTAssertNil(SpriteLoader.load("does-not-exist"))
    }

    func testFrameIndexingWrapsAround() throws {
        let set = try XCTUnwrap(SpriteLoader.load("dog"))
        let count = set.frameCount(for: .working)
        // Each tick should resolve to *something*, including ticks past the
        // end of the strip — wrap-around must be modular and never crash.
        let first = set.image(for: .working, tick: 0)
        let wrapped = set.image(for: .working, tick: count)
        let negative = set.image(for: .working, tick: -1)
        XCTAssertNotNil(first)
        XCTAssertNotNil(wrapped)
        XCTAssertNotNil(negative)
        // tick=0 and tick=count should resolve to the same frame.
        XCTAssertTrue(first === wrapped || first?.tiffRepresentation == wrapped?.tiffRepresentation)
    }

    func testFrameCountIsAtLeastOneForUnknownMood() {
        // Even if a sprite set lacks frames for `.hidden`, frameCount should
        // not return zero — callers divide-mod by it.
        let empty = SpriteSet(name: "empty", frames: [:])
        XCTAssertGreaterThanOrEqual(empty.frameCount(for: .working), 1)
    }
}
