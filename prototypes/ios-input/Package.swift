// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "IOSInputSession",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "IOSInputSession", targets: ["IOSInputSession"])],
    targets: [
        .target(name: "IOSInputSession"),
        .testTarget(name: "IOSInputSessionTests", dependencies: ["IOSInputSession"])
    ]
)
