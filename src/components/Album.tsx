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
  const codesAvailable = codes?.length;
  const navigate = useNavigate();
  const navigateToRelease = () => {
    navigate(`/release/${id}`);
  };
  return (
    <div className="card w-[17.5%] bg-base-100 shadow-xl image-full m-5 indicator">
      {codesAvailable === 0 ? (
        <span className="code-indicator-error sub-text indicator-center indicator-bottom">
          No Codes Left!
        </span>
      ) : (
        <span className="code-indicator sub-text indicator-center indicator-bottom">
          {codesAvailable} Codes Available!
        </span>
      )}
      <figure>
        <img src={image} alt={name} />
      </figure>
      <div className="justify-end card-body text-center p-3">
        <h2 className="album-title">{name}</h2>
        <p className="album-desc">
          {releaseType} by {artist}
        </p>
        <div className="flex-row card-actions">
          <a href={link} target="_blank" className="bandcamp-button">
            Bandcamp
          </a>
          {codesAvailable > 0 ? (
            <button className="code-button" onClick={navigateToRelease}>
              Get Code
            </button>
          ) : (
            <button className="release-button" onClick={navigateToRelease}>
              Learn More
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Album;
