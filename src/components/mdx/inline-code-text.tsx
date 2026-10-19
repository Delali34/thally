import { Fragment } from 'react'
import { inlineCodeParts } from '@/lib/inline-code'

/**
 * A title string with its `code` spans rendered as code, as Mintlify does for
 * Step and Accordion titles and the page description. Everything else stays
 * text; ids and outlines read `plainInlineText` of the same string.
 */
export function InlineCodeText({ children }: { children: string }) {
  return (
    <>
      {inlineCodeParts(children).map((part, index) =>
        part.code ? <code key={index}>{part.text}</code> : <Fragment key={index}>{part.text}</Fragment>,
      )}
    </>
  )
}
