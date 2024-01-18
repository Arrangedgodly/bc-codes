import { ReleaseProps } from "../types";

const Album: React.FC<ReleaseProps> = ({
  name,
  artist,
  codes,
  image,
  link,
  releaseDate,
  releaseType,
}) => {
  const codesAvailable = codes.length;
  return (
    <div className="card w-1/5 bg-base-100 shadow-xl image-full m-5 indicator">
      {codesAvailable === 0 ? (
        <span className="indicator-item indicator-center indicator-bottom badge badge-lg badge-error text-2xl z-10">
          No Codes Left!
        </span>
      ) : (
        <span className="indicator-item indicator-center indicator-bottom badge badge-lg badge-success text-2xl z-10">
          {codesAvailable} Codes Available!
        </span>
      )}
      <figure>
        <img src={image} alt={name} />
      </figure>
      <div className="justify-end card-body text-center">
        <h2 className="card-title m-auto text-4xl">{name}</h2>
        <p className="text-xl">
          {releaseType} by {artist}
        </p>
        <div className="flex-row card-actions">
          <a
            href={link}
            target="_blank"
            className="btn btn-secondary w-[45%] mx-auto text-xl"
          >
            Bandcamp
          </a>
          {codesAvailable > 0 ? (
            <button className="btn btn-accent w-[45%] mx-auto text-xl">
              Get Code
            </button>
          ) : (
            <button className="btn btn-tertiary w-[45%] mx-auto text-xl">
              Learn More
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Album;
