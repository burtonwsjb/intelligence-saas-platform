import { monogram } from "@/lib/display";

/**
 * Artwork slot with a reserved 5:7 card ratio. The catalog does not yet carry
 * verified exact-printing artwork, so this renders an honest placeholder rather
 * than a similar card's image.
 */
export function CardArt({ cardName, setName, collectorNumber }: { cardName: string; setName: string; collectorNumber: string }) {
  return (
    <div className="art-placeholder" role="img" aria-label={`No verified artwork for ${cardName}, ${setName} #${collectorNumber}`}>
      <span className="art-monogram" aria-hidden="true">
        {monogram(cardName)}
      </span>
      <span className="art-note" aria-hidden="true">
        {setName} · #{collectorNumber}
      </span>
      <span className="art-note" aria-hidden="true">
        Artwork not verified yet
      </span>
    </div>
  );
}
