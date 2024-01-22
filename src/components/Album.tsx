import { useNavigate } from "react-router-dom";

type AlbumProps = {
  id: string;
  name: string;
  artist: string;
  codes: string[];
  image: string;
  link: string;
  releaseType: string;
};

const Album: React.FC<AlbumProps> = ({
  id,
  name,
  artist,
  codes,
  image,
  link,
  releaseType,
}) => {
  const codesAvailable = codes.length;
  const navigate = useNavigate();
  const navigateToRelease = () => {
    navigate(`/release/${id}`);
  };
  return (
    <div className="card w-[250px] bg-base-100 shadow-xl image-full m-5 indicator">
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
            className="btn btn-secondary w-full mx-auto text-xl"
          >
            Bandcamp
          </a>
          {codesAvailable > 0 ? (
            <button
              className="btn btn-accent w-full mx-auto text-xl"
              onClick={navigateToRelease}
            >
              Get Code
            </button>
          ) : (
            <button
              className="btn btn-tertiary w-full mx-auto text-xl"
              onClick={navigateToRelease}
            >
              Learn More
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Album;
