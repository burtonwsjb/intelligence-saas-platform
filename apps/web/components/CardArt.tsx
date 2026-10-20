import { monogram } from "@/lib/display";

/**
 * Artwork slot with a reserved 5:7 card ratio. Shows the card's picture from
 * TCG Card Central's catalog when the printing has one, otherwise an honest
 * placeholder rather than a similar card's image.
 */
export function CardArt({
  cardName,
  setName,
  collectorNumber,
  imageUrl,
}: {
  cardName: string;
  setName: string;
  collectorNumber: string;
  imageUrl?: string | null;
}) {
  if (imageUrl) {
    return (
      // A plain img: card pictures come from several hosts and are already sized.
      <img
        src={imageUrl}
        alt={`${cardName}, ${setName} #${collectorNumber}`}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    );
  }
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
