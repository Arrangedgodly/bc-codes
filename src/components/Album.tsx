type AlbumProps = {
  name: string;
  image: string;
};

const Album: React.FC<AlbumProps> = ({ name, image }) => {
  return (
    <div className="carousel-item h-full">
      <div className="card w-96 bg-base-100 shadow-xl image-full">
        <figure>
          <img src={image} alt={name} />
        </figure>
        <div className="justify-end card-body text-center">
          <h2 className="card-title">{name}</h2>
          <div className="card-actions">
            <button className="btn btn-secondary">Bandcamp</button>
            <button className="btn btn-tertiary">Generate Code</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Album;
