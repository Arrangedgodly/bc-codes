import { useState, useEffect } from "react";
import { getRelease } from "../firebase";
import { useParams } from "react-router-dom";

const AlbumPage = () => {
  const [release, setRelease] = useState<any>(null);
  const { releaseId } = useParams();

  useEffect(() => {
    const getReleaseData = async () => {
      const releaseData = await getRelease(releaseId || "");
      setRelease(releaseData);
    };
    getReleaseData();
  }, [releaseId]);

  const convertDate = (date: string) => {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    return new Date(date).toLocaleDateString("en-US", options);
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen w-full">
      <h1 className="text-6xl m-5 mx-auto font-bold mt-[7%]">
        {release?.name}
      </h1>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        <img
          src={release?.image}
          alt={release?.name}
          className="w-[300px] h-[300px] object-cover rounded-xl"
        />
      </div>
      <p className="text-3xl m-7 mt-3 mx-auto">
        {release?.releaseType} by {release?.artist}
      </p>
      <p className="text-3xl m-7 mt-3 mx-auto italic">
        Released: {convertDate(release?.releaseDate)}
      </p>
      <p className="text-5xl m-7 mt-3 mx-auto">
        Codes Available: {release?.codes.length}
      </p>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        <div className="btn btn-primary btn-lg text-3xl">Get Code!</div>
        <div className="btn btn-secondary btn-lg text-3xl">Bandcamp</div>
        <div className="btn btn-accent btn-lg text-3xl">Notify Me</div>
      </div>
    </div>
  );
};

export default AlbumPage;
