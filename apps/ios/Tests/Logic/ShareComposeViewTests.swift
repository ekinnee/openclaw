import Foundation
import Testing
import UIKit

@MainActor
struct ShareComposeViewTests {
    @Test func `retry after failure keeps request key`() {
        let view = ShareComposeView(frame: .zero)
        view.setDraft("Summarize this share")
        let key = view.requestKey

        view.apply(.sending)
        view.apply(.failed("Response was lost"))
        #expect(view.requestKey == key)
        view.apply(.sending)
        view.apply(.failed("Gateway rejected the request"))
        #expect(view.requestKey == key)
    }

    @Test func `edited message gets new request key`() {
        let view = ShareComposeView(frame: .zero)
        view.setDraft("Original request")
        let originalKey = view.requestKey

        view.apply(.failed("Response was lost"))
        view.setDraft("Edited request")
        let editedKey = view.requestKey
        #expect(editedKey != originalKey)

        // Returning to old text is a fresh edit, not a retry of its earlier send.
        view.setDraft("Original request")
        #expect(view.requestKey != originalKey)
        #expect(view.requestKey != editedKey)
    }

    @Test func `unchanged transmitted message keeps request key`() {
        let view = ShareComposeView(frame: .zero)
        view.setDraft("Summarize this share")
        let key = view.requestKey

        view.setDraft("  Summarize this share\n")
        #expect(view.requestKey == key)
        view.setDraft("Summarize this share")
        #expect(view.requestKey == key)
    }

    @Test func `separate shares have distinct request keys`() {
        let first = ShareComposeView(frame: .zero)
        let second = ShareComposeView(frame: .zero)
        first.setDraft("Same content")
        second.setDraft("Same content")
        #expect(first.requestKey != second.requestKey)
    }

    @Test func `text view edits rotate request key`() throws {
        let view = ShareComposeView(frame: .zero)
        view.setDraft("Original request")
        let originalKey = view.requestKey
        let contentStack = try #require(view.subviews.compactMap { $0 as? UIStackView }.first)
        let textView = try #require(contentStack.arrangedSubviews.compactMap { $0 as? UITextView }.first)

        textView.text = "User edit"
        view.textViewDidChange(textView)
        #expect(view.requestKey != originalKey)
    }
}
