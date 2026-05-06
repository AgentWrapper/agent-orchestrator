// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AOPet",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "AOPet", targets: ["AOPet"])
    ],
    targets: [
        .executableTarget(
            name: "AOPet",
            path: "Sources/AOPet",
            resources: [
                .copy("Resources/sprites")
            ]
        ),
        .testTarget(
            name: "AOPetTests",
            dependencies: ["AOPet"],
            path: "Tests/AOPetTests"
        )
    ]
)
